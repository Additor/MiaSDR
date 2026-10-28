import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { campaigns, linkedinAccounts, linkedinSearchBatches, linkedinSearchQueries, linkedinSearchResults } from "@/platform/db/schema";
import { recordAudit } from "@/contexts/tenancy/infrastructure/audit";
import type { DbHandle } from "@/platform/db/client";
import type { LinkedInSearchBatchStore, SearchBatchDetail, SearchBatchSummary, SearchResultExportRow } from "../application/linkedin-search-ports";
import { ACTIVE_SEARCH_STATUSES, RERUNNABLE_STATUS } from "../domain/linkedin-search-batch";
import { DEFAULT_MAX_RESULTS, type SearchStatus } from "../domain/linkedin-search";

const q = linkedinSearchQueries;
const b = linkedinSearchBatches;
const BULK = "bulk";
const RUNNING = "running";
const ACTIVE_URL_LIMIT = 20_000;
const DETAIL_QUERY_LIMIT = 1000;

async function summaries(organizationId: string, where: ReturnType<typeof and>): Promise<SearchBatchSummary[]> {
  const batches = await db.select({ id: b.id, name: b.name, createdAt: b.createdAt, targetCampaignId: b.targetCampaignId }).from(b).where(where).orderBy(sql`${b.createdAt} desc`, sql`${b.id} desc`).limit(100);
  if (batches.length === 0) return [];
  const ids = batches.map((x) => x.id);
  const groups = await db
    .select({
      batchId: q.batchId,
      status: q.status,
      n: sql<number>`count(*)::int`,
      found: sql<number>`coalesce(sum(${q.leadsFetched}), 0)::int`,
      imported: sql<number>`coalesce(sum(${q.importedCount}), 0)::int`,
      campaignId: sql<string | null>`(array_agg(${q.targetCampaignId}))[1]`,
    })
    .from(q)
    .where(and(eq(q.organizationId, organizationId), inArray(q.batchId, ids)))
    .groupBy(q.batchId, q.status);
  const campaignIds = [...new Set([...groups.map((g) => g.campaignId), ...batches.map((x) => x.targetCampaignId)].filter((id): id is string => id !== null))];
  const names = new Map(
    campaignIds.length === 0 ? [] : (await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(and(eq(campaigns.organizationId, organizationId), inArray(campaigns.id, campaignIds)))).map((c) => [c.id, c.name] as const),
  );
  return batches.map((batch) => {
    const mine = groups.filter((g) => g.batchId === batch.id);
    const campaignId = mine.find((g) => g.campaignId)?.campaignId ?? batch.targetCampaignId ?? null;
    return {
      id: batch.id,
      name: batch.name,
      createdAt: batch.createdAt,
      queries: mine.reduce((sum, g) => sum + g.n, 0),
      statuses: Object.fromEntries(mine.map((g) => [g.status, g.n])) as SearchBatchSummary["statuses"],
      found: mine.reduce((sum, g) => sum + g.found, 0),
      imported: mine.reduce((sum, g) => sum + g.imported, 0),
      campaign: campaignId && names.has(campaignId) ? { id: campaignId, name: names.get(campaignId)! } : null,
    };
  });
}

export const drizzleLinkedInSearchBatchStore: LinkedInSearchBatchStore = {
  async createBatch(organizationId, input) {
    return db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(b)
        .values({
          organizationId,
          name: input.name,
          kind: BULK,
          accountIds: input.accountIds,
          createdBy: input.createdBy,
          sourceFilename: input.sourceFilename,
          rowsTotal: input.rowsTotal,
          rowsRejected: input.rowsRejected,
          rejections: input.rejections,
          maxResults: input.maxResults,
          targetCampaignId: input.campaignId,
        })
        .returning({ id: b.id });
      await tx.insert(q).values(
        input.rows.map((row) => ({
          organizationId,
          batchId: batch.id,
          url: row.url,
          companyName: row.companyName,
          sourceRow: row.sourceRow,
          maxResults: input.maxResults,
          targetCampaignId: input.campaignId,
        })),
      );
      return batch.id;
    });
  },

  async activeUrls(organizationId) {
    const rows = await db
      .select({ url: q.url })
      .from(q)
      .where(and(eq(q.organizationId, organizationId), inArray(q.status, [...ACTIVE_SEARCH_STATUSES])))
      .limit(ACTIVE_URL_LIMIT);
    return rows.map((r) => r.url);
  },

  async knownAccountIds(organizationId, ids) {
    if (ids.length === 0) return [];
    const rows = await db.select({ id: linkedinAccounts.id }).from(linkedinAccounts).where(and(eq(linkedinAccounts.organizationId, organizationId), inArray(linkedinAccounts.id, ids)));
    return rows.map((r) => r.id);
  },

  async accounts(organizationId) {
    return db
      .select({ id: linkedinAccounts.id, name: sql<string>`coalesce(${linkedinAccounts.name}, ${linkedinAccounts.username})` })
      .from(linkedinAccounts)
      .where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.status, "connected")))
      .orderBy(asc(linkedinAccounts.createdAt));
  },

  async list(organizationId) {
    return summaries(organizationId, and(eq(b.organizationId, organizationId), eq(b.kind, BULK)));
  },

  async get(organizationId, id): Promise<SearchBatchDetail | null> {
    const [summary] = await summaries(organizationId, and(eq(b.organizationId, organizationId), eq(b.kind, BULK), eq(b.id, id)));
    if (!summary) return null;
    const [batch] = await db
      .select({ maxResults: b.maxResults, accountIds: b.accountIds, createdBy: b.createdBy, sourceFilename: b.sourceFilename, rowsTotal: b.rowsTotal, rowsRejected: b.rowsRejected, rejections: b.rejections })
      .from(b).where(and(eq(b.organizationId, organizationId), eq(b.id, id)));
    const accounts =
      batch.accountIds.length === 0
        ? []
        : await db
            .select({ name: sql<string>`coalesce(${linkedinAccounts.name}, ${linkedinAccounts.username})` })
            .from(linkedinAccounts)
            .where(and(eq(linkedinAccounts.organizationId, organizationId), inArray(linkedinAccounts.id, batch.accountIds)));
    const items = await db
      .select({ id: q.id, url: q.url, companyName: q.companyName, status: q.status, found: q.leadsFetched, maxResults: q.maxResults, imported: q.importedCount, lastError: q.lastError, sourceRow: q.sourceRow, rerunCount: q.rerunCount })
      .from(q)
      .where(and(eq(q.organizationId, organizationId), eq(q.batchId, id)))
      // Rows of one upload share a timestamp. The sheet row keeps their order; searches added later have none and follow.
      .orderBy(sql`${q.sourceRow} asc nulls last`, asc(q.createdAt), asc(q.id))
      .limit(DETAIL_QUERY_LIMIT);
    return {
      ...summary,
      accountNames: accounts.map((a) => a.name),
      accountIds: batch.accountIds,
      createdBy: batch.createdBy,
      sourceFilename: batch.sourceFilename,
      rowsTotal: batch.rowsTotal,
      rowsRejected: batch.rowsRejected,
      rejections: batch.rejections ?? [],
      maxResults: batch.maxResults ?? items[0]?.maxResults ?? 0,
      items: items.map((i) => ({ ...i, status: i.status as SearchStatus })),
    };
  },

  async rerunFailed(organizationId, batchId, ids) {
    const rows = await db
      .update(q)
      .set({ status: "queued", rerunCount: sql`${q.rerunCount} + 1`, leaseUntil: null, nextPageAt: null, failures: 0, lastError: null, completedAt: null })
      .where(and(eq(q.organizationId, organizationId), eq(q.batchId, batchId), eq(q.status, RERUNNABLE_STATUS), ids ? inArray(q.id, ids) : undefined))
      .returning({ id: q.id });
    return rows.length;
  },

  async *resultPages(organizationId, batchId, size): AsyncGenerator<SearchResultExportRow[]> {
    const r = linkedinSearchResults;
    // Keyset on (created_at, id): stable while the search keeps adding rows, and each page is one indexed read.
    let after: { createdAt: string; id: string } | null = null;
    for (;;) {
      const rows: Array<{ id: string; createdAtText: string } & SearchResultExportRow> = await db
        .select({
          id: r.id,
          createdAtText: sql<string>`${r.createdAt}::text`,
          companyName: q.companyName,
          searchUrl: q.url,
          profileUrl: r.profileUrl,
          name: r.name,
          headline: r.headline,
          location: r.location,
          networkDistance: r.networkDistance,
          inLeads: sql<boolean>`${r.personId} is not null`,
        })
        .from(r)
        .innerJoin(q, eq(q.id, r.queryId))
        .where(
          and(
            eq(r.organizationId, organizationId),
            eq(q.batchId, batchId),
            after ? or(gt(sql`${r.createdAt}::text`, after.createdAt), and(eq(sql`${r.createdAt}::text`, after.createdAt), gt(r.id, after.id))) : undefined,
          ),
        )
        .orderBy(asc(r.createdAt), asc(r.id))
        .limit(size);
      if (rows.length === 0) return;
      const last = rows[rows.length - 1];
      after = { createdAt: last.createdAtText, id: last.id };
      yield rows.map((row) => ({
        companyName: row.companyName,
        searchUrl: row.searchUrl,
        profileUrl: row.profileUrl,
        name: row.name,
        headline: row.headline,
        location: row.location,
        networkDistance: row.networkDistance,
        inLeads: row.inLeads,
      }));
      if (rows.length < size) return;
    }
  },

  async addQueries(organizationId, batchId, rows, maxQueries) {
    return db.transaction(async (tx) => {
      // The batch row serializes concurrent adds, so the size check below sees the other writer's rows.
      const locked = await tx
        .select({ id: b.id, maxResults: b.maxResults, targetCampaignId: b.targetCampaignId })
        .from(b)
        .where(and(eq(b.organizationId, organizationId), eq(b.id, batchId), eq(b.kind, BULK)))
        .for("update");
      if (locked.length === 0) return { added: 0, alreadyInBatch: 0, tooMany: false, total: 0 };
      const [first] = await tx
        .select({ maxResults: q.maxResults, targetCampaignId: q.targetCampaignId })
        .from(q)
        .where(and(eq(q.organizationId, organizationId), eq(q.batchId, batchId)))
        .orderBy(asc(q.createdAt), asc(q.id))
        .limit(1);
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(q).where(and(eq(q.organizationId, organizationId), eq(q.batchId, batchId)));
      if (n + rows.length > maxQueries) return { added: 0, alreadyInBatch: 0, tooMany: true, total: n };
      if (rows.length === 0) return { added: 0, alreadyInBatch: 0, tooMany: false, total: n };
      const inserted = await tx
        .insert(q)
        .values(rows.map((row) => ({ organizationId, batchId, url: row.url, companyName: row.companyName, maxResults: locked[0].maxResults ?? first?.maxResults ?? DEFAULT_MAX_RESULTS, targetCampaignId: locked[0].targetCampaignId ?? first?.targetCampaignId ?? null })))
        .onConflictDoNothing()
        .returning({ id: q.id });
      return { added: inserted.length, alreadyInBatch: rows.length - inserted.length, tooMany: false, total: n + inserted.length };
    });
  },

  async removeQueries(organizationId, batchId, ids, audit) {
    return db.transaction(async (tx) => {
      const locked = await lockQueries(tx, organizationId, batchId, ids);
      const running = locked.filter((row) => row.status === RUNNING).length;
      if (running > 0) return { ok: false as const, reason: "running" as const, running };
      const queryIds = locked.map((row) => row.id);
      const resultsRemoved = await deleteResultRows(tx, organizationId, queryIds);
      if (queryIds.length > 0) await tx.delete(q).where(and(eq(q.organizationId, organizationId), inArray(q.id, queryIds)));
      const notFound = ids ? ids.length - queryIds.length : 0;
      if (queryIds.length > 0) await recordAudit(tx, { organizationId, actorUserId: audit.actorUserId, action: "search_batch.urls_removed", entityType: "linkedin_search_batch", entityId: batchId, meta: { removed: queryIds.length, resultsRemoved } });
      return { ok: true as const, removed: queryIds.length, resultsRemoved, notFound };
    });
  },

  async deleteResults(organizationId, batchId, ids, audit) {
    return db.transaction(async (tx) => {
      const locked = await lockQueries(tx, organizationId, batchId, ids);
      const running = locked.filter((row) => row.status === RUNNING).length;
      if (running > 0) return { ok: false as const, reason: "running" as const, running };
      const queryIds = locked.map((row) => row.id);
      const resultsRemoved = await deleteResultRows(tx, organizationId, queryIds);
      if (queryIds.length > 0) {
        // `leads_fetched` is a lifetime counter: it enforces `max_results` against the search's cursor. Zeroing it with the rows
        // would let a resumed search fetch another full allowance. `imported_count` stays too, since the imported leads stay.
        // So "found" on the batch page counts every person the search ever fetched, not only the rows still stored.
        await recordAudit(tx, { organizationId, actorUserId: audit.actorUserId, action: "search_batch.results_deleted", entityType: "linkedin_search_batch", entityId: batchId, meta: { searches: queryIds.length, resultsRemoved } });
      }
      return { ok: true as const, searches: queryIds.length, resultsRemoved, notFound: ids ? ids.length - queryIds.length : 0 };
    });
  },

  async deleteBatch(organizationId, batchId, audit) {
    return db.transaction(async (tx) => {
      const [batch] = await tx.select({ id: b.id, name: b.name }).from(b).where(and(eq(b.organizationId, organizationId), eq(b.id, batchId), eq(b.kind, BULK))).for("update");
      if (!batch) return { ok: true as const, searches: 0, resultsRemoved: 0 };
      const locked = await lockQueries(tx, organizationId, batchId, null);
      const running = locked.filter((row) => row.status === RUNNING).length;
      if (running > 0) return { ok: false as const, reason: "running" as const, running };
      const [{ n }] =
        locked.length === 0
          ? [{ n: 0 }]
          : await tx.select({ n: sql<number>`count(*)::int` }).from(linkedinSearchResults).where(and(eq(linkedinSearchResults.organizationId, organizationId), inArray(linkedinSearchResults.queryId, locked.map((row) => row.id))));
      // Searches and results leave through the cascades of their foreign keys.
      await tx.delete(b).where(and(eq(b.organizationId, organizationId), eq(b.id, batchId)));
      await recordAudit(tx, { organizationId, actorUserId: audit.actorUserId, action: "search_batch.deleted", entityType: "linkedin_search_batch", entityId: batchId, meta: { name: batch.name, searches: locked.length, resultsRemoved: n } });
      return { ok: true as const, searches: locked.length, resultsRemoved: n };
    });
  },

  async runNow(organizationId, batchId, ids) {
    return db.transaction(async (tx) => {
      const scope = and(eq(q.organizationId, organizationId), eq(q.batchId, batchId), ids ? inArray(q.id, ids) : undefined);
      // A resume starts clean, like the Resume button: no lease, no backoff, no old error. The cursor stays.
      const resumed = await tx
        .update(q)
        .set({ status: "queued", leaseUntil: null, nextPageAt: null, failures: 0, lastError: null, completedAt: null })
        .where(and(scope, eq(q.status, "paused")))
        .returning({ id: q.id });
      const due = await tx
        .update(q)
        .set({ nextPageAt: null })
        .where(and(scope, eq(q.status, "queued"), sql`${q.nextPageAt} is not null`))
        .returning({ id: q.id });
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(q).where(and(scope, eq(q.status, "queued")));
      return Math.max(n, resumed.length + due.length);
    });
  },
};

/** Locks the named searches of the batch (all of them when `ids` is null) in id order, so two calls cannot deadlock. A claim holds the same lock while it sets `running`. */
async function lockQueries(tx: DbHandle, organizationId: string, batchId: string, ids: string[] | null) {
  return tx
    .select({ id: q.id, status: q.status })
    .from(q)
    .where(and(eq(q.organizationId, organizationId), eq(q.batchId, batchId), ids ? inArray(q.id, ids) : undefined))
    .orderBy(asc(q.id))
    .for("update");
}

async function deleteResultRows(tx: DbHandle, organizationId: string, queryIds: string[]): Promise<number> {
  if (queryIds.length === 0) return 0;
  // A count, not the rows: a batch can hold many thousands of stored results.
  const [row] = (await tx.execute(sql`
    with gone as (
      delete from linkedin_search_results where organization_id = ${organizationId} and query_id in (${sql.join(queryIds.map((id) => sql`${id}`), sql`, `)}) returning 1
    )
    select count(*)::int as n from gone
  `)) as unknown as Array<{ n: number }>;
  return row.n;
}
