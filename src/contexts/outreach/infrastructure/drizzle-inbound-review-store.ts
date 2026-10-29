import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { inboundEvents, mailboxes, users } from "@/platform/db/schema";
import { MAX_EVENT_ATTEMPTS } from "../linkedin/domain/linkedin";
import type { InboundEventState, InboundReviewStore, InboundSource, InboundStateFilter } from "../application/inbound-review";
import { deadLetterNote, hasDeadLetterNote, withoutDeadLetterNote } from "../email/application/sync-inbox";

const ERROR_CHARS = 300;
const DEAD_LETTER_WINDOW_MS = 7 * 24 * 3600 * 1000;

const p = inboundEvents;

/** Classifies a row in SQL, so filters and counts agree with the labels on screen. */
const stateExpr = sql<InboundEventState>`case
  when ${p.status} = 'failed' and ${p.provider} = 'gmail' then 'dead'
  when ${p.status} = 'failed' and ${p.provider} = 'unipile' and ${p.attempts} >= ${MAX_EVENT_ATTEMPTS} then 'dead'
  when ${p.status} = 'pending' and ${p.provider} = 'gmail' and ${p.attempts} = 0 then 'queued'
  when ${p.status} = 'failed' and ${p.provider} = 'unipile' and ${p.attempts} = 0 then 'queued'
  when ${p.status} = 'pending' and ${p.provider} = 'gmail' then 'retrying'
  when ${p.status} = 'failed' and ${p.provider} = 'unipile' then 'retrying'
  when ${p.status} = 'skipped' and ${p.log} @> '[{"level":"dismissed"}]'::jsonb then 'dismissed'
  else 'closed' end`;

const inStates = (...states: InboundEventState[]) => sql`${stateExpr} in (${sql.join(states.map((s) => sql`${s}`), sql`, `)})`;

const filterSql = (state: InboundStateFilter): SQL =>
  state === "open" ? inStates("dead", "queued") : state === "all" ? sql`${stateExpr} <> 'closed'` : sql`${stateExpr} = ${state}`;

const entry = (level: string, message: string, now: Date, by?: string) => JSON.stringify([{ ts: now.toISOString(), level, message, ...(by ? { by } : {}) }]);

type LogLine = { ts: string; level: string; message: string; by?: string };

/** After a Gmail dead letter was retried or dismissed, drops or recounts the sentence in the mailbox error. */
async function refreshMailboxNote(organizationId: string, address: string, now: Date) {
  const [mailbox] = await db
    .select({ id: mailboxes.id, lastError: mailboxes.lastError })
    .from(mailboxes)
    .where(and(eq(mailboxes.organizationId, organizationId), eq(mailboxes.emailAddress, address)));
  if (!mailbox || !hasDeadLetterNote(mailbox.lastError)) return;
  const [{ n }] = await db
    .select({ n: count() })
    .from(inboundEvents)
    .where(
      and(
        eq(p.provider, "gmail"),
        eq(p.organizationId, organizationId),
        eq(p.accountRef, address),
        eq(p.eventType, "inbound_email"),
        eq(p.status, "failed"),
        sql`${p.createdAt} >= ${new Date(now.getTime() - DEAD_LETTER_WINDOW_MS).toISOString()}::timestamptz`,
      ),
    );
  const rest = withoutDeadLetterNote(mailbox.lastError);
  const next = [rest, n > 0 ? deadLetterNote(n) : null].filter((t) => t !== null).join(" ") || null;
  await db.update(mailboxes).set({ lastError: next }).where(eq(mailboxes.id, mailbox.id));
}

export const drizzleInboundReviewStore: InboundReviewStore = {
  async list(organizationId, query) {
    const where = and(
      eq(p.organizationId, organizationId),
      query.source === "all" ? undefined : eq(p.provider, query.source === "gmail" ? "gmail" : "unipile"),
      filterSql(query.state),
    );
    const [{ n }] = await db.select({ n: count() }).from(p).where(where);
    const rows = await db
      .select({
        id: p.id,
        provider: p.provider,
        accountRef: p.accountRef,
        eventType: p.eventType,
        attempts: p.attempts,
        state: stateExpr,
        payload: p.payload,
        log: p.log,
        createdAt: p.createdAt,
      })
      .from(p)
      .where(where)
      .orderBy(desc(p.createdAt), desc(p.id))
      .limit(query.limit)
      .offset(query.offset);

    const dismissers = new Set<string>();
    const lines = rows.map((r) => r.log as LogLine[]);
    for (const log of lines) {
      const by = [...log].reverse().find((l) => l.level === "dismissed")?.by;
      if (by) dismissers.add(by);
    }
    const names = new Map<string, string>();
    if (dismissers.size > 0) {
      for (const u of await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, [...dismissers]))) names.set(u.id, u.name || u.email);
    }

    return {
      total: n,
      rows: rows.map((r, i) => {
        const log = lines[i];
        const lastError = [...log].reverse().find((l) => l.level === "error");
        const dismissed = [...log].reverse().find((l) => l.level === "dismissed");
        const payload = (r.payload ?? {}) as { subject?: unknown; from?: { email?: unknown } };
        const source: InboundSource = r.provider === "gmail" ? "gmail" : "linkedin";
        return {
          id: r.id,
          source,
          accountRef: r.accountRef,
          eventType: r.eventType,
          state: r.state as Exclude<InboundEventState, "closed">,
          attempts: r.attempts,
          error: lastError ? lastError.message.slice(0, ERROR_CHARS) : null,
          subject: source === "gmail" && typeof payload.subject === "string" ? payload.subject.slice(0, 120) : null,
          from: source === "gmail" && typeof payload.from?.email === "string" ? payload.from.email : null,
          createdAt: r.createdAt,
          lastAttemptAt: log.length > 0 ? new Date(log[log.length - 1].ts) : null,
          dismissedAt: r.state === "dismissed" && dismissed ? new Date(dismissed.ts) : null,
          dismissedBy: r.state === "dismissed" && dismissed?.by ? (names.get(dismissed.by) ?? null) : null,
        };
      }),
    };
  },

  async getState(organizationId, id) {
    const [row] = await db
      .select({ state: stateExpr })
      .from(p)
      .where(and(eq(p.id, id), eq(p.organizationId, organizationId)));
    return row?.state ?? null;
  },

  async requestRetry(organizationId, id, now) {
    const rows = await db
      .update(p)
      .set({
        status: sql`case when ${p.provider} = 'gmail' then 'pending' else 'failed' end`,
        attempts: 0,
        nextAttemptAt: now,
        leaseUntil: null,
        claimToken: null,
        processedAt: null,
        log: sql`${p.log} || ${entry("retry", "Retry requested.", now)}::jsonb`,
      })
      .where(and(eq(p.id, id), eq(p.organizationId, organizationId), inStates("dead", "dismissed")))
      .returning({ provider: p.provider, accountRef: p.accountRef });
    if (rows.length === 0) return false;
    if (rows[0].provider === "gmail" && rows[0].accountRef) await refreshMailboxNote(organizationId, rows[0].accountRef, now);
    return true;
  },

  async dismiss(organizationId, id, userId, now) {
    const rows = await db
      .update(p)
      .set({ status: "skipped", leaseUntil: null, processedAt: now, log: sql`${p.log} || ${entry("dismissed", "Dismissed.", now, userId)}::jsonb` })
      .where(and(eq(p.id, id), eq(p.organizationId, organizationId), inStates("dead", "retrying", "queued")))
      .returning({ provider: p.provider, accountRef: p.accountRef });
    if (rows.length === 0) return false;
    if (rows[0].provider === "gmail" && rows[0].accountRef) await refreshMailboxNote(organizationId, rows[0].accountRef, now);
    return true;
  },
};
