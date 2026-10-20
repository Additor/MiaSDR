import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { campaigns, channelSettings, linkedinAccounts, linkedinSearchBatches, linkedinSearchQueries, linkedinSearchResults } from "@/platform/db/schema";
import type { LinkedInSearchEngineStore, LinkedInSearchRecord, LinkedInSearchStore, SearchPageClaim } from "../application/linkedin-search-ports";
import { linkedinRules } from "../domain/linkedin";
import { SEARCH_LEASE_SECONDS, allowedFrom, searchDay, searchQuotaLeft, statusAfter, type SearchStatus } from "../domain/linkedin-search";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const CLAIMABLE = ["queued", "running", "paused_limit"];
const LIVE = ["running", "paused"];
const CHUNK = 200;

const q = linkedinSearchQueries;
const secondsFrom = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

async function linkedinValues(tx: Tx, organizationId: string): Promise<Record<string, unknown> | null> {
  const [row] = await tx
    .select({ values: channelSettings.values })
    .from(channelSettings)
    .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, "linkedin")));
  return row?.values ?? null;
}

function toRecord(row: {
  id: string;
  name: string;
  url: string;
  status: string;
  maxResults: number;
  found: number;
  imported: number;
  totalEstimate: number | null;
  pagesFetched: number;
  lastError: string | null;
  campaignId: string | null;
  campaignName: string | null;
  account: string | null;
  nextPageAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}): LinkedInSearchRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    variant: row.url.includes("/sales/") ? "sales_navigator" : "classic",
    status: row.status as SearchStatus,
    maxResults: row.maxResults,
    found: row.found,
    imported: row.imported,
    totalEstimate: row.totalEstimate,
    pagesFetched: row.pagesFetched,
    lastError: row.lastError,
    targetCampaign: row.campaignId && row.campaignName ? { id: row.campaignId, name: row.campaignName } : null,
    account: row.account,
    nextPageAt: row.nextPageAt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

const recordColumns = {
  id: q.id,
  name: linkedinSearchBatches.name,
  url: q.url,
  status: q.status,
  maxResults: q.maxResults,
  found: q.leadsFetched,
  imported: q.importedCount,
  totalEstimate: q.totalCount,
  pagesFetched: q.pagesFetched,
  lastError: q.lastError,
  campaignId: campaigns.id,
  campaignName: campaigns.name,
  account: sql<string | null>`coalesce(${linkedinAccounts.name}, ${linkedinAccounts.username})`,
  nextPageAt: q.nextPageAt,
  createdAt: q.createdAt,
  startedAt: q.startedAt,
  completedAt: q.completedAt,
};

/** Batches with this kind hold a single search the person created by hand. Every other kind is a bulk batch. */
const SINGLE = "single";
const BATCH_LINK_LIMIT = 50;

const selectRecords = () =>
  db
    .select(recordColumns)
    .from(q)
    .innerJoin(linkedinSearchBatches, eq(linkedinSearchBatches.id, q.batchId))
    .leftJoin(campaigns, eq(campaigns.id, q.targetCampaignId))
    .leftJoin(linkedinAccounts, eq(linkedinAccounts.id, q.currentAccountId));

export const drizzleLinkedInSearchStore: LinkedInSearchStore = {
  async create(organizationId, input) {
    return db.transaction(async (tx) => {
      const [batch] = await tx.insert(linkedinSearchBatches).values({ organizationId, name: input.name, kind: SINGLE }).returning({ id: linkedinSearchBatches.id });
      const [query] = await tx
        .insert(q)
        .values({ organizationId, batchId: batch.id, url: input.url, maxResults: input.maxResults, targetCampaignId: input.campaignId })
        .returning({ id: q.id });
      return query.id;
    });
  },

  async list(organizationId) {
    // Queries of a bulk batch live on the batch page, where the batch actions and the sheet order are.
    const rows = await selectRecords()
      .where(and(eq(q.organizationId, organizationId), eq(linkedinSearchBatches.kind, SINGLE)))
      .orderBy(desc(q.createdAt), desc(q.id))
      .limit(200);
    return rows.map(toRecord);
  },

  async listBatches(organizationId) {
    const rows = await db
      .select({ id: linkedinSearchBatches.id, name: linkedinSearchBatches.name, searches: sql<number>`count(${q.id})::int` })
      .from(linkedinSearchBatches)
      .innerJoin(q, eq(q.batchId, linkedinSearchBatches.id))
      .where(and(eq(linkedinSearchBatches.organizationId, organizationId), ne(linkedinSearchBatches.kind, SINGLE)))
      .groupBy(linkedinSearchBatches.id, linkedinSearchBatches.name, linkedinSearchBatches.createdAt)
      .orderBy(desc(linkedinSearchBatches.createdAt), desc(linkedinSearchBatches.id))
      .limit(BATCH_LINK_LIMIT);
    return rows;
  },

  async get(organizationId, id) {
    const [row] = await selectRecords().where(and(eq(q.organizationId, organizationId), eq(q.id, id)));
    return row ? toRecord(row) : null;
  },

  async apply(organizationId, id, action) {
    const resume = action === "resume";
    const rows = await db
      .update(q)
      .set({
        status: statusAfter(action),
        // A resume starts clean: no lease, no backoff, no old error. The cursor stays, so it continues where it stopped.
        ...(resume ? { leaseUntil: null, nextPageAt: null, failures: 0, lastError: null, completedAt: null } : {}),
        ...(action === "cancel" ? { completedAt: new Date() } : {}),
      })
      .where(and(eq(q.organizationId, organizationId), eq(q.id, id), inArray(q.status, allowedFrom(action))))
      .returning({ id: q.id });
    return rows.length > 0;
  },

  async countConnectedAccounts(organizationId) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(linkedinAccounts)
      .where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.status, "connected")));
    return row.n;
  },
};

interface Candidate {
  id: string;
  organization_id: string;
  url: string;
  status: string;
  cursor: string | null;
  current_account_id: string | null;
  leads_fetched: number;
  max_results: number;
  pages_fetched: number;
  failures: number;
  target_campaign_id: string | null;
  last_error: string | null;
  /** Accounts the batch may use, as account ids. Empty: any connected account of the organization. */
  allowed_account_ids: string[];
}

export const drizzleLinkedInSearchEngineStore: LinkedInSearchEngineStore = {
  async claimPage({ now }) {
    return db.transaction(async (tx) => {
      const nowIso = now.toISOString();
      const due = (await tx.execute(sql`
        select q.id, q.organization_id, q.url, q.status, q.cursor, q.current_account_id, q.leads_fetched, q.max_results, q.pages_fetched, q.failures, q.target_campaign_id, q.last_error,
          b.account_ids as allowed_account_ids
        from linkedin_search_queries q
        join linkedin_search_batches b on b.id = q.batch_id
        where q.status in (${sql.join(CLAIMABLE.map((s) => sql`${s}`), sql`, `)})
          and (q.status <> 'running' or q.lease_until is null or q.lease_until < ${nowIso}::timestamptz)
          and (q.next_page_at is null or q.next_page_at <= ${nowIso}::timestamptz)
        order by q.created_at asc
        limit 10
        for update of q skip locked
      `)) as unknown as Candidate[];

      const day = searchDay(now);
      for (const search of due) {
        const rules = linkedinRules(await linkedinValues(tx, search.organization_id));
        const allowed = search.allowed_account_ids ?? [];
        const accounts = await tx
          .select()
          .from(linkedinAccounts)
          .where(
            and(
              eq(linkedinAccounts.organizationId, search.organization_id),
              eq(linkedinAccounts.status, "connected"),
              allowed.length > 0 ? inArray(linkedinAccounts.id, allowed) : undefined,
            ),
          )
          .for("update", { skipLocked: true });

        const used = (a: (typeof accounts)[number]) => (a.searchDay === day ? a.searchLeadsToday : 0);
        const left = (a: (typeof accounts)[number]) => searchQuotaLeft({ limit: rules.searchLeadsPerDay, usedToday: used(a) });
        const idle = (a: (typeof accounts)[number]) => !a.searchLeaseUntil || a.searchLeaseUntil <= now;
        const unrestricted = (a: (typeof accounts)[number]) => !a.limitReachedUntil || a.limitReachedUntil <= now;
        const usable = (a: (typeof accounts)[number]) => idle(a) && unrestricted(a) && left(a) > 0;

        let account: (typeof accounts)[number] | undefined;
        let restart = false;
        if (search.cursor && search.current_account_id) {
          // A cursor belongs to the account that began the session.
          const holder = accounts.find((a) => a.id === search.current_account_id);
          if (holder && usable(holder)) account = holder;
          else if (holder && !idle(holder)) continue;
          else if (!holder) {
            const [row] = await tx.select({ status: linkedinAccounts.status }).from(linkedinAccounts).where(eq(linkedinAccounts.id, search.current_account_id));
            if (row?.status === "connected") continue; // another claim holds its row right now
            restart = true;
          } else restart = true; // paused for a limit or out of allowance: start over elsewhere
        }
        if (!account) {
          account = accounts.filter(usable).sort((a, b) => left(b) - left(a))[0];
          restart = restart || search.cursor !== null;
        }

        if (!account) {
          const note = accounts.length === 0 ? (allowed.length > 0 ? "None of this batch's LinkedIn accounts is connected." : "No LinkedIn account is connected.") : accounts.every((a) => left(a) <= 0) ? "Every connected account used its daily search allowance." : null;
          if (note) {
            const status = accounts.length > 0 && note.startsWith("Every") ? "paused_limit" : search.status;
            if (status !== search.status || note !== search.last_error) await tx.update(q).set({ status, lastError: note }).where(eq(q.id, search.id));
          }
          continue;
        }

        const leaseUntil = secondsFrom(now, SEARCH_LEASE_SECONDS);
        await tx
          .update(q)
          .set({
            status: "running",
            leaseUntil,
            currentAccountId: account.id,
            ...(restart ? { cursor: null } : {}),
            startedAt: sql`coalesce(${q.startedAt}, ${nowIso}::timestamptz)`,
          })
          .where(eq(q.id, search.id));
        await tx
          .update(linkedinAccounts)
          .set({ searchLeaseUntil: leaseUntil, searchDay: day, searchLeadsToday: used(account) })
          .where(eq(linkedinAccounts.id, account.id));

        return {
          searchId: search.id,
          organizationId: search.organization_id,
          url: search.url,
          cursor: restart ? null : search.cursor,
          maxResults: search.max_results,
          found: search.leads_fetched,
          pagesFetched: search.pages_fetched,
          targetCampaignId: search.target_campaign_id,
          failures: search.failures,
          quotaLeft: left(account),
          gapSeconds: rules.searchGapSeconds,
          account: { id: account.id, providerAccountId: account.providerAccountId },
          leaseUntil,
        } satisfies SearchPageClaim;
      }
      return null;
    });
  },

  async isCurrent(claim) {
    const rows = await db
      .select({ id: q.id })
      .from(q)
      .where(and(eq(q.id, claim.searchId), eq(q.leaseUntil, claim.leaseUntil), inArray(q.status, LIVE)));
    return rows.length > 0;
  },

  async recordPage(claim, page, now, gapSeconds) {
    return db.transaction(async (tx) => {
      const gapUntil = secondsFrom(now, gapSeconds);
      const day = searchDay(now);
      // The account was read whether or not the search still wants the page, so the allowance counts either way.
      await tx
        .update(linkedinAccounts)
        .set({
          searchLeadsToday: sql`(case when ${linkedinAccounts.searchDay} = ${day} then ${linkedinAccounts.searchLeadsToday} else 0 end) + ${page.received}`,
          searchDay: day,
          searchLeaseUntil: gapUntil,
        })
        .where(eq(linkedinAccounts.id, claim.account.id));

      const [live] = await tx
        .select({ id: q.id })
        .from(q)
        .where(and(eq(q.id, claim.searchId), eq(q.leaseUntil, claim.leaseUntil), inArray(q.status, LIVE)))
        .for("update");
      if (!live) return null;

      const results = await page.results(tx);
      let inserted = 0;
      let imported = 0;
      for (let i = 0; i < results.length; i += CHUNK) {
        const rows = await tx
          .insert(linkedinSearchResults)
          .values(
            results.slice(i, i + CHUNK).map((r) => ({
              organizationId: claim.organizationId,
              queryId: claim.searchId,
              profileUrl: r.profileUrl,
              personId: r.personId,
              name: r.item.name,
              headline: r.item.headline,
              location: r.item.location,
              networkDistance: r.item.networkDistance,
              raw: r.item.raw,
            })),
          )
          .onConflictDoNothing()
          .returning({ personId: linkedinSearchResults.personId });
        inserted += rows.length;
        imported += rows.filter((r) => r.personId !== null).length;
      }

      // The cap counts stored results, so a page read again after a restart does not end the search early.
      const done = page.done || claim.found + inserted >= claim.maxResults;
      const [updated] = await tx
        .update(q)
        .set({
          leadsFetched: sql`${q.leadsFetched} + ${inserted}`,
          importedCount: sql`${q.importedCount} + ${imported}`,
          pagesFetched: sql`${q.pagesFetched} + 1`,
          cursor: done ? null : page.nextCursor,
          totalCount: page.totalEstimate ?? sql`${q.totalCount}`,
          failures: 0,
          lastError: null,
          leaseUntil: null,
          nextPageAt: gapUntil,
          currentAccountId: claim.account.id,
          status: done ? "completed" : sql`${q.status}`,
          completedAt: done ? now : null,
        })
        .where(eq(q.id, claim.searchId))
        .returning({ status: q.status });
      return { inserted, imported, status: updated.status as SearchStatus };
    });
  },

  async release(claim, input) {
    await db.transaction(async (tx) => {
      await tx
        .update(q)
        .set({
          leaseUntil: null,
          nextPageAt: input.retryAt,
          lastError: input.error,
          failures: input.unknownFailure ? sql`${q.failures} + 1` : q.failures,
        })
        .where(and(eq(q.id, claim.searchId), eq(q.leaseUntil, claim.leaseUntil)));
      await tx.update(linkedinAccounts).set({ searchLeaseUntil: null }).where(eq(linkedinAccounts.id, claim.account.id));
    });
  },

  async fail(claim, error, now) {
    await db.transaction(async (tx) => {
      await tx
        .update(q)
        .set({ status: "failed", lastError: error.slice(0, 500), leaseUntil: null, completedAt: now })
        .where(and(eq(q.id, claim.searchId), eq(q.leaseUntil, claim.leaseUntil), inArray(q.status, LIVE)));
      await tx.update(linkedinAccounts).set({ searchLeaseUntil: null }).where(eq(linkedinAccounts.id, claim.account.id));
    });
  },

  async pauseAccountForLimit(claim, until) {
    await db.transaction(async (tx) => {
      await tx.update(linkedinAccounts).set({ limitReachedUntil: until, searchLeaseUntil: null }).where(eq(linkedinAccounts.id, claim.account.id));
      await restartElsewhere(tx, claim, "LinkedIn limited this account. The search continues on another account, or when the pause ends.");
    });
  },

  async disconnectAccount(claim, error) {
    await db.transaction(async (tx) => {
      await tx
        .update(linkedinAccounts)
        .set({
          status: "disconnected",
          searchLeaseUntil: null,
          profileData: sql`jsonb_set(coalesce(${linkedinAccounts.profileData}, '{}'::jsonb), '{lastError}', to_jsonb(${error}::text))`,
        })
        .where(eq(linkedinAccounts.id, claim.account.id));
      await restartElsewhere(tx, claim, "The LinkedIn account was disconnected. The search continues on another account.");
    });
  },
};

/** A cursor only works on its own account, so a search that loses its account starts over at page 1. Stored results stay. */
async function restartElsewhere(tx: Tx, claim: SearchPageClaim, note: string) {
  await tx
    .update(q)
    .set({ cursor: null, currentAccountId: null, leaseUntil: null, nextPageAt: null, lastError: note })
    .where(and(eq(q.id, claim.searchId), eq(q.leaseUntil, claim.leaseUntil)));
}
