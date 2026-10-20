import { and, desc, eq, inArray, isNull, notLike, or, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { recordAudit } from "@/platform/db/audit";
import { auditLog, inboundEvents, jobRuns, linkedinAccounts, users } from "@/platform/db/schema";
import { TICK_FAILURE_PREFIX } from "@/platform/jobs/failure-log";
import { claimSlot, finishSlot } from "@/platform/jobs/slots";
import { MAX_EVENT_ATTEMPTS } from "../domain/linkedin";
import type { AuditSink } from "../application/linkedin-management";
import type { LinkedInOperationsStore, WebhookBacklog } from "../application/linkedin-operations";

const p = inboundEvents;

const entry = (message: string, now: Date) => JSON.stringify([{ ts: now.toISOString(), level: "retry", message }]);

export const drizzleAuditSink: AuditSink = {
  async record(e) {
    await recordAudit(db, e);
  },
};

export const drizzleLinkedInOperationsStore: LinkedInOperationsStore = {
  async recentRuns(organizationId, limit) {
    return db
      .select({ id: jobRuns.id, job: jobRuns.job, slot: jobRuns.slot, status: jobRuns.status, organizationId: jobRuns.organizationId, startedAt: jobRuns.startedAt, finishedAt: jobRuns.finishedAt, error: jobRuns.error })
      .from(jobRuns)
      .where(and(or(eq(jobRuns.organizationId, organizationId), isNull(jobRuns.organizationId)), notLike(jobRuns.job, `${TICK_FAILURE_PREFIX}%`)))
      .orderBy(desc(jobRuns.startedAt))
      .limit(limit);
  },

  async recentAudit(organizationId, actions, limit) {
    return db
      .select({ id: auditLog.id, action: auditLog.action, actorName: users.name, meta: auditLog.meta, createdAt: auditLog.createdAt })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(and(eq(auditLog.organizationId, organizationId), inArray(auditLog.action, actions)))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
  },

  async webhookBacklog(organizationId): Promise<WebhookBacklog> {
    const [row] = await db
      .select({
        dead: sql<number>`(count(*) filter (where ${p.attempts} >= ${MAX_EVENT_ATTEMPTS}))::int`,
        retrying: sql<number>`(count(*) filter (where ${p.attempts} > 0 and ${p.attempts} < ${MAX_EVENT_ATTEMPTS}))::int`,
        queued: sql<number>`(count(*) filter (where ${p.attempts} = 0))::int`,
      })
      .from(p)
      .where(and(eq(p.organizationId, organizationId), eq(p.provider, "unipile"), eq(p.status, "failed")));
    return { dead: row?.dead ?? 0, retrying: row?.retrying ?? 0, queued: row?.queued ?? 0 };
  },

  async requeueFailedWebhooks(organizationId, now, limit) {
    const rows = await db.execute(sql`
      update inbound_events ev
         set attempts = 0, next_attempt_at = ${now.toISOString()}::timestamptz, lease_until = null,
             replay_count = ev.replay_count + 1, last_replayed_at = ${now.toISOString()}::timestamptz,
             log = ev.log || ${entry("Replay requested.", now)}::jsonb
       where ev.id in (
         select id from inbound_events
          where organization_id = ${organizationId} and provider = 'unipile' and status = 'failed' and attempts > 0
          order by created_at asc
          limit ${limit}
          for update skip locked
       )
      returning ev.id
    `);
    return (rows as unknown as unknown[]).length;
  },

  async resetDailyCounters(organizationId, now) {
    return db.transaction(async (tx) => {
      const accounts = await tx
        .select({ id: linkedinAccounts.id, paused: sql<boolean>`${linkedinAccounts.limitReachedUntil} is not null and ${linkedinAccounts.limitReachedUntil} > ${now.toISOString()}::timestamptz`, search: linkedinAccounts.searchLeadsToday })
        .from(linkedinAccounts)
        .where(eq(linkedinAccounts.organizationId, organizationId))
        .for("update");
      if (accounts.length > 0) {
        await tx.update(linkedinAccounts).set({ limitReachedUntil: null, searchLeadsToday: 0 }).where(eq(linkedinAccounts.organizationId, organizationId));
      }
      return { accounts: accounts.length, pausesCleared: accounts.filter((a) => a.paused).length, searchCountersCleared: accounts.filter((a) => a.search > 0).length };
    });
  },

  async recordManualRun({ organizationId, job, now, error }) {
    // The slot is unique per call, so every manual run gets its own row.
    const claim = await claimSlot(job, `manual:${now.toISOString()}:${Math.random().toString(36).slice(2, 8)}`, { organizationId, now, leaseMs: 60_000 });
    if (claim) await finishSlot(claim, error ? { status: "failed", error } : { status: "succeeded" }, now);
  },
};
