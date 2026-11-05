import { and, asc, count, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import { heldBy, NEW_CLAIM_TOKEN } from "@/platform/db/claim";
import { violatedConstraint } from "@/platform/db/errors";
import { channelSettings, miaRuns, miaSuggestions, miaUsageDaily } from "@/platform/db/schema";
import { brainStoreIn } from "@/contexts/brain/infrastructure/composition";
import { cleanJson, cleanString } from "@/contexts/grid/domain/cell-values";
import { recordAudit } from "@/contexts/tenancy/infrastructure/audit";
import { mergeChannelSettings } from "@/contexts/tenancy/infrastructure/channel-settings";
import { ConflictError } from "@/shared/errors";
import type { AiUsage } from "@/contexts/ai/domain/generation";
import { MIA_ACTIVE_STATUSES } from "../domain/mia-run";
import { countedTokens, MIA_SETTINGS_CHANNEL, readMiaSettings, utcDay } from "../domain/mia-settings";
import type { ClaimedRun, MiaRunStore, MiaSettingsStore, MiaSuggestionStore, RunFailure, RunRow, SuggestionRecord } from "../application/mia-ports";

const ACTIVE = [...MIA_ACTIVE_STATUSES];
/** How long a finished run stays on the Brain page. */
const RECENT_MS = 30 * 60_000;
const ONE_RUN_INDEXES = new Set(["mia_runs_one_fill_uq", "mia_runs_one_sort_uq"]);

/** The claim this worker still holds. A later claim writes a new token, so a late write of this one matches nothing. */
const held = (run: ClaimedRun) => and(eq(miaRuns.id, run.id), eq(miaRuns.status, "running"), heldBy("mia_runs", run));

/** Ends the lease. The token goes too, so no later statement matches this claim. */
const UNLOCK = { claimToken: null, leaseExpiresAt: null } as const;

/** What a finished run keeps: not the person's text, the pages or the conversation. */
const ENDED = { ...UNLOCK, checkpoint: null, input: {} } as const;

async function addUsage(tx: DbTx, organizationId: string, now: Date, usage: AiUsage): Promise<void> {
  const values = {
    organizationId,
    day: utcDay(now),
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd === undefined ? null : String(usage.costUsd),
  };
  await tx
    .insert(miaUsageDaily)
    .values(values)
    .onConflictDoUpdate({
      target: [miaUsageDaily.organizationId, miaUsageDaily.day],
      set: {
        inputTokens: sql`${miaUsageDaily.inputTokens} + ${values.inputTokens}`,
        cacheReadTokens: sql`${miaUsageDaily.cacheReadTokens} + ${values.cacheReadTokens}`,
        cacheWriteTokens: sql`${miaUsageDaily.cacheWriteTokens} + ${values.cacheWriteTokens}`,
        outputTokens: sql`${miaUsageDaily.outputTokens} + ${values.outputTokens}`,
        ...(values.costUsd === null ? {} : { costUsd: sql`coalesce(${miaUsageDaily.costUsd}, 0) + ${values.costUsd}::numeric` }),
        updatedAt: new Date(),
      },
    });
}

const charged = (tokens: number | undefined): AiUsage => ({ inputTokens: tokens ?? 0, outputTokens: 0 });

/** Records a failure's rough token count against the day and the run, with the status change `set` makes. */
async function endWithFailure(run: ClaimedRun, failure: RunFailure, set: Partial<typeof miaRuns.$inferInsert>): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(miaRuns)
      .set({ ...set, error: cleanString(failure.error), failureKind: failure.failureKind, usedTokens: run.usedTokens + (failure.chargedTokens ?? 0) })
      .where(held(run))
      .returning({ id: miaRuns.id });
    if (updated.length === 0) return false;
    if (failure.chargedTokens) await addUsage(tx, run.organizationId, failure.now, charged(failure.chargedTokens));
    return true;
  });
}

interface ClaimRow {
  id: string;
  organization_id: string;
  capability: ClaimedRun["capability"];
  input: Record<string, unknown>;
  checkpoint: Record<string, unknown> | null;
  step_count: number;
  used_tokens: number;
  suggestion_count: number;
  attempts: number;
  failures: number;
  claim_token: string;
}

export const drizzleMiaRunStore: MiaRunStore = {
  async create(organizationId, run) {
    try {
      return await db.transaction(async (tx) => {
        const [row] = await tx.insert(miaRuns).values({ organizationId, capability: run.capability, requestedBy: run.requestedBy, input: cleanJson(run.input) }).returning({ id: miaRuns.id });
        await recordAudit(tx, { organizationId, actorUserId: run.requestedBy, action: "mia.run_started", entityType: "mia_run", entityId: row.id, meta: { capability: run.capability } });
        return row;
      });
    } catch (error) {
      const index = violatedConstraint(error, "23505");
      if (index && ONE_RUN_INDEXES.has(index)) throw new ConflictError("Mia is already working on this. Wait for it to finish, or stop it first.", { code: "mia_run_active" });
      throw error;
    }
  },

  async claim(now, leaseMs, limit) {
    const nowIso = now.toISOString();
    const until = new Date(now.getTime() + leaseMs).toISOString();
    const rows = (await db.execute(sql`
      update mia_runs set
        status = 'running',
        claim_token = ${NEW_CLAIM_TOKEN},
        attempts = attempts + 1,
        -- A lease that ran out means a worker died during a step. Count it, so a run that kills workers ends.
        failures = failures + (case when status = 'running' then 1 else 0 end),
        lease_expires_at = ${until}::timestamptz,
        started_at = coalesce(started_at, ${nowIso}::timestamptz),
        updated_at = ${nowIso}::timestamptz
      where id in (
        select id from mia_runs
        where (status in ('queued', 'waiting_limit') and next_attempt_at <= ${nowIso}::timestamptz)
           or (status = 'running' and lease_expires_at < ${nowIso}::timestamptz)
        order by next_attempt_at
        limit ${limit}
        for update skip locked
      )
      returning id, organization_id, capability, input, checkpoint, step_count, used_tokens, suggestion_count, attempts, failures, claim_token
    `)) as unknown as ClaimRow[];
    return rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      capability: r.capability,
      input: r.input,
      checkpoint: r.checkpoint,
      stepCount: r.step_count,
      usedTokens: r.used_tokens,
      suggestionCount: r.suggestion_count,
      attempts: r.attempts,
      failures: r.failures,
      claimToken: r.claim_token,
    }));
  },

  async hasDue(now) {
    const nowIso = now.toISOString();
    const rows = (await db.execute(sql`
      select 1 from mia_runs
      where (status in ('queued', 'waiting_limit') and next_attempt_at <= ${nowIso}::timestamptz)
         or (status = 'running' and lease_expires_at < ${nowIso}::timestamptz)
      limit 1
    `)) as unknown as unknown[];
    return rows.length > 0;
  },

  // Web pages can hold \u0000 and a cut can leave half a surrogate pair. Postgres rejects both in jsonb, and a rejected write here repeats a paid call.
  async saveStep(run, step) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(miaRuns)
        .set({
          stepCount: sql`${miaRuns.stepCount} + 1`,
          usedTokens: sql`${miaRuns.usedTokens} + ${countedTokens(step.usage)}`,
          suggestionCount: sql`${miaRuns.suggestionCount} + ${step.suggestions.length}`,
          provider: step.provider,
          model: step.model,
          failures: 0,
          error: null,
          failureKind: null,
          ...(step.finished ? { ...ENDED, status: "succeeded" as const, finishedAt: step.now } : { checkpoint: cleanJson(step.checkpoint), leaseExpiresAt: new Date(step.now.getTime() + step.leaseMs) }),
        })
        .where(held(run))
        .returning({ stepCount: miaRuns.stepCount });
      if (!row) return false;
      if (step.suggestions.length > 0) {
        await tx.insert(miaSuggestions).values(step.suggestions.map((s) => ({ organizationId: run.organizationId, runId: run.id, stepCount: row.stepCount, ordinal: s.ordinal, type: s.type, targetItemId: s.targetItemId, kind: s.kind, title: cleanString(s.title), payload: cleanJson(s.payload) })));
      }
      await addUsage(tx, run.organizationId, step.now, step.usage);
      return true;
    });
  },

  retryLater(run, at, failure) {
    return endWithFailure(run, failure, { ...UNLOCK, status: "queued", nextAttemptAt: at, failures: run.failures + 1 });
  },

  fail(run, failure) {
    return endWithFailure(run, failure, { ...ENDED, status: "failed", finishedAt: failure.now });
  },

  async succeed(run, now) {
    const updated = await db.update(miaRuns).set({ ...ENDED, status: "succeeded", finishedAt: now }).where(held(run)).returning({ id: miaRuns.id });
    return updated.length > 0;
  },

  async cancelled(run, now) {
    const updated = await db.update(miaRuns).set({ ...ENDED, status: "cancelled", finishedAt: now }).where(held(run)).returning({ id: miaRuns.id });
    return updated.length > 0;
  },

  async release(run, at, status) {
    const updated = await db.update(miaRuns).set({ ...UNLOCK, status, nextAttemptAt: at }).where(held(run)).returning({ id: miaRuns.id });
    return updated.length > 0;
  },

  async cancelRequested(run) {
    const [row] = await db.select({ at: miaRuns.cancelRequestedAt }).from(miaRuns).where(held(run));
    return Boolean(row?.at);
  },

  async usedToday(organizationId, now) {
    const [row] = await db
      .select({ input: miaUsageDaily.inputTokens, write: miaUsageDaily.cacheWriteTokens, output: miaUsageDaily.outputTokens })
      .from(miaUsageDaily)
      .where(and(eq(miaUsageDaily.organizationId, organizationId), eq(miaUsageDaily.day, utcDay(now))));
    return row ? row.input + row.write + row.output : 0;
  },

  async requestCancel(organizationId, runId, actorUserId, now) {
    return db.transaction(async (tx) => {
      const [run] = await tx
        .select({ status: miaRuns.status })
        .from(miaRuns)
        .where(and(eq(miaRuns.id, runId), eq(miaRuns.organizationId, organizationId), inArray(miaRuns.status, ACTIVE)))
        .for("update");
      if (!run) return false;
      // A running one is mid-step: its worker holds the claim and ends the run at its next step.
      if (run.status === "running") await tx.update(miaRuns).set({ cancelRequestedAt: now }).where(eq(miaRuns.id, runId));
      else await tx.update(miaRuns).set({ ...ENDED, status: "cancelled", cancelRequestedAt: now, finishedAt: now }).where(eq(miaRuns.id, runId));
      await recordAudit(tx, { organizationId, actorUserId, action: "mia.run_cancelled", entityType: "mia_run", entityId: runId, meta: {} });
      return true;
    });
  },

  async recent(organizationId, now) {
    const rows = await db
      .select({
        id: miaRuns.id,
        capability: miaRuns.capability,
        status: miaRuns.status,
        url: sql<string | null>`${miaRuns.input}->>'url'`,
        suggestionCount: miaRuns.suggestionCount,
        error: miaRuns.error,
        cancelRequestedAt: miaRuns.cancelRequestedAt,
        nextAttemptAt: miaRuns.nextAttemptAt,
        createdAt: miaRuns.createdAt,
      })
      .from(miaRuns)
      .where(and(eq(miaRuns.organizationId, organizationId), or(inArray(miaRuns.status, ACTIVE), gte(miaRuns.finishedAt, new Date(now.getTime() - RECENT_MS)))))
      .orderBy(desc(miaRuns.createdAt))
      .limit(10);
    return rows.map(({ url, cancelRequestedAt, ...row }): RunRow => ({ ...row, site: url ? new URL(url).hostname : null, cancelRequested: cancelRequestedAt !== null }));
  },
};

const suggestionColumns = {
  id: miaSuggestions.id,
  type: miaSuggestions.type,
  status: miaSuggestions.status,
  targetItemId: miaSuggestions.targetItemId,
  kind: miaSuggestions.kind,
  title: miaSuggestions.title,
  payload: miaSuggestions.payload,
  createdAt: miaSuggestions.createdAt,
};

export const drizzleMiaSuggestionStore: MiaSuggestionStore = {
  async listOpen(organizationId, limit) {
    return db
      .select(suggestionColumns)
      .from(miaSuggestions)
      .where(and(eq(miaSuggestions.organizationId, organizationId), eq(miaSuggestions.status, "open")))
      .orderBy(desc(miaSuggestions.createdAt), asc(miaSuggestions.ordinal))
      .limit(limit) as Promise<SuggestionRecord[]>;
  },

  async countOpen(organizationId) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(miaSuggestions)
      .where(and(eq(miaSuggestions.organizationId, organizationId), eq(miaSuggestions.status, "open")));
    return total;
  },

  async decide(organizationId, id, actorUserId, now, decide) {
    return db.transaction(async (tx) => {
      const [suggestion] = await tx
        .select(suggestionColumns)
        .from(miaSuggestions)
        .where(and(eq(miaSuggestions.id, id), eq(miaSuggestions.organizationId, organizationId)))
        .for("update");
      if (!suggestion) return false;
      const decided = await decide(suggestion as SuggestionRecord, brainStoreIn(tx));
      await tx
        .update(miaSuggestions)
        .set({ status: decided.status, decidedBy: actorUserId, decidedAt: now, ...(decided.createdItemId ? { createdItemId: decided.createdItemId } : {}) })
        .where(eq(miaSuggestions.id, id));
      return true;
    });
  },
};

export const drizzleMiaSettingsStore: MiaSettingsStore = {
  async read(organizationId) {
    const [row] = await db
      .select({ values: channelSettings.values })
      .from(channelSettings)
      .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, MIA_SETTINGS_CHANNEL)));
    return readMiaSettings(row?.values);
  },

  async save(organizationId, actorUserId, patch) {
    await db.transaction(async (tx) => {
      await mergeChannelSettings(tx, organizationId, MIA_SETTINGS_CHANNEL, patch, actorUserId);
      await recordAudit(tx, { organizationId, actorUserId, action: "mia.settings_changed", entityType: "organization", entityId: organizationId, meta: { ...patch } });
    });
    return drizzleMiaSettingsStore.read(organizationId);
  },
};
