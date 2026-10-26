import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { recordAudit } from "@/platform/db/audit";
import { dealStages, deals } from "@/platform/db/schema";
import { DEFAULT_DEAL_STAGES, type DealStageKind } from "../domain/stages";
import type { DealRow, DealStage, DealStore, NewDeal, StoppedCounts } from "../application/deal-ports";
import { rowsOf } from "@/platform/db/sql-values";

/*
 * `deals` and `deal_stages` writes. Every statement filters by organization. Structure changes of the stage list take the
 * organization's pipeline lock (`pipelineLock`); a deal write locks only its own row.
 */

const pipelineLock = (tx: DbHandle, organizationId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deal-stages:${organizationId}`}, 0))`);

const stageColumns = { id: dealStages.id, name: dealStages.name, kind: dealStages.kind, position: dealStages.position };
const asStage = (row: { id: string; name: string; kind: string; position: number }): DealStage => ({ ...row, kind: row.kind as DealStageKind });

const dealColumns = {
  id: deals.id,
  personId: deals.personId,
  stageId: deals.stageId,
  stageKind: deals.stageKind,
  title: deals.title,
  ownerUserId: deals.ownerUserId,
  amountMinor: deals.amountMinor,
  currency: deals.currency,
  expectedCloseOn: deals.expectedCloseOn,
  closedAt: deals.closedAt,
  lostReason: deals.lostReason,
  stageChangedAt: deals.stageChangedAt,
  sourceEnrollmentId: deals.sourceEnrollmentId,
  version: deals.version,
  createdBy: deals.createdBy,
  createdAt: deals.createdAt,
  updatedAt: deals.updatedAt,
};
type DealSelect = { [K in keyof typeof dealColumns]: unknown };
const asDeal = (row: DealSelect): DealRow => ({ ...(row as unknown as DealRow), stageKind: row.stageKind as DealStageKind });

async function listStages(organizationId: string, handle: DbHandle = db): Promise<DealStage[]> {
  const rows = await handle.select(stageColumns).from(dealStages).where(eq(dealStages.organizationId, organizationId)).orderBy(asc(dealStages.position), asc(dealStages.id));
  return rows.map(asStage);
}

export const drizzleDealStore: DealStore = {
  async ensureStages(tx, organizationId) {
    // Unlocked first: an organization with stages takes no lock, so deal creation never queues behind stage settings.
    const existing = await listStages(organizationId, tx);
    if (existing.length > 0) return existing;
    await pipelineLock(tx, organizationId);
    const again = await listStages(organizationId, tx);
    if (again.length > 0) return again;
    const values = sql.join(
      DEFAULT_DEAL_STAGES.map((s) => sql`(${organizationId}::uuid, ${s.name}, ${s.kind}, ${s.position})`),
      sql`, `,
    );
    // The case-insensitive name index is the arbiter: the deferrable position key cannot be one.
    await tx.execute(sql`insert into deal_stages (organization_id, name, kind, position) values ${values} on conflict (organization_id, lower(name)) do nothing`);
    return listStages(organizationId, tx);
  },

  listStages,

  async stageDealCounts(organizationId, handle = db) {
    const rows = await handle
      .select({ stageId: deals.stageId, count: sql<number>`count(*)::int` })
      .from(deals)
      .where(eq(deals.organizationId, organizationId))
      .groupBy(deals.stageId);
    return new Map(rows.map((r) => [r.stageId, r.count]));
  },

  async byIdempotencyKey(tx, organizationId, personId, key) {
    const [row] = rowsOf<{ id: string; stopped: StoppedCounts | null }>(
      await tx.execute(sql`
        select d.id, created.meta->'stopped' as stopped
        from deals d
        left join lateral (
          select e.meta from events e
          where e.organization_id = d.organization_id and e.person_id = d.person_id and e.event_type = 'deal.created' and e.meta->>'dealId' = d.id::text
          limit 1
        ) created on true
        where d.organization_id = ${organizationId} and d.person_id = ${personId}::uuid and d.idempotency_key = ${key}`),
    );
    if (!row) return null;
    const stopped = row.stopped ?? { enrollments: 0, runs: 0, drafts: 0 };
    return { dealId: row.id, stopped: { enrollments: stopped.enrollments ?? 0, runs: stopped.runs ?? 0, drafts: stopped.drafts ?? 0 } };
  },

  async primaryDealIdOfPerson(tx, organizationId, personId) {
    const [row] = await tx
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.organizationId, organizationId), eq(deals.personId, personId)))
      .orderBy(sql`(${deals.stageKind} = 'open') desc, ${deals.createdAt} desc, ${deals.id} desc`)
      .limit(1);
    return row?.id ?? null;
  },

  async insert(tx, deal: NewDeal) {
    const [row] = await tx
      .insert(deals)
      .values({ ...deal, createdAt: deal.stageChangedAt, updatedAt: deal.stageChangedAt })
      // A concurrent call with the same key inserted first: no row, and the caller replays that call's deal.
      .onConflictDoNothing({ target: [deals.organizationId, deals.personId, deals.idempotencyKey], where: sql`${deals.idempotencyKey} is not null` })
      .returning(dealColumns);
    return row ? asDeal(row) : null;
  },

  async lock(tx, organizationId, dealId) {
    const [row] = await tx.select(dealColumns).from(deals).where(and(eq(deals.organizationId, organizationId), eq(deals.id, dealId))).for("update");
    return row ? asDeal(row) : null;
  },

  async update(tx, organizationId, dealId, patch, now) {
    const [row] = await tx
      .update(deals)
      .set({ ...patch, version: sql`${deals.version} + 1`, updatedAt: now })
      .where(and(eq(deals.organizationId, organizationId), eq(deals.id, dealId)))
      .returning(dealColumns);
    return asDeal(row);
  },

  async delete(tx, organizationId, dealId) {
    await tx.delete(deals).where(and(eq(deals.organizationId, organizationId), eq(deals.id, dealId)));
  },

  async lockStages(tx, organizationId) {
    await pipelineLock(tx, organizationId);
    return listStages(organizationId, tx);
  },

  async insertStage(tx, organizationId, stage) {
    const [row] = await tx.insert(dealStages).values({ organizationId, ...stage }).returning(stageColumns);
    return asStage(row);
  },

  async renameStage(tx, organizationId, stageId, name, now) {
    await tx.update(dealStages).set({ name, updatedAt: now }).where(and(eq(dealStages.organizationId, organizationId), eq(dealStages.id, stageId)));
  },

  async setPositions(tx, organizationId, positions, now) {
    if (positions.length === 0) return;
    // One statement: the position key is DEFERRABLE INITIALLY DEFERRED, so the commit checks the final order.
    const cases = sql.join(positions.map((p) => sql`when ${p.id}::uuid then ${p.position}::int`), sql` `);
    await tx
      .update(dealStages)
      .set({ position: sql`case ${dealStages.id} ${cases} end`, updatedAt: now })
      .where(and(eq(dealStages.organizationId, organizationId), inArray(dealStages.id, positions.map((p) => p.id))));
  },

  async deleteStage(tx, organizationId, stageId) {
    await tx.delete(dealStages).where(and(eq(dealStages.organizationId, organizationId), eq(dealStages.id, stageId)));
  },

  audit: (tx, entry) => recordAudit(tx, entry),
};
