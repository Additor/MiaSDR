import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";
import { db, type DbHandle, type DbTx } from "@/platform/db/client";
import { violatedConstraint } from "@/platform/db/errors";
import { miaMessages, miaThreadPeople, miaThreads } from "@/platform/db/schema";
import { cleanJson, cleanString } from "@/contexts/grid/domain/cell-values";
import { CHAT_HISTORY, partsText, threadTitle, TURN_STALE_MS, type ChatPart } from "../domain/mia-chat";
import { countedTokens } from "../domain/mia-settings";
import type { ClaimedTurn, MessageRow, MiaChatStore, ThreadRow, TurnStart } from "../application/chat-ports";
import { addUsage } from "./drizzle-mia-store";

const threadColumns = {
  id: miaThreads.id,
  title: miaThreads.title,
  personId: miaThreads.personId,
  purgedAt: miaThreads.purgedAt,
  lastMessageAt: miaThreads.lastMessageAt,
  createdAt: miaThreads.createdAt,
};

const owned = (organizationId: string, userId: string, id: string) => and(eq(miaThreads.id, id), eq(miaThreads.organizationId, organizationId), eq(miaThreads.userId, userId));

interface LockedThread {
  id: string;
  person_id: string | null;
  turn_token: string | null;
  turn_started_at: string | null;
}

async function lockThread(tx: DbTx, organizationId: string, userId: string, threadId: string): Promise<LockedThread | null> {
  const rows = (await tx.execute(sql`
    select id, person_id, turn_token, turn_started_at from mia_threads
    where id = ${threadId}::uuid and organization_id = ${organizationId}::uuid and user_id = ${userId}::uuid
    for update`)) as unknown as LockedThread[];
  return rows[0] ?? null;
}

/** A turn that started less than `TURN_STALE_MS` ago is still answering. One older than that died with its process. */
const busy = (thread: LockedThread, now: Date) => thread.turn_token !== null && thread.turn_started_at !== null && now.getTime() - new Date(thread.turn_started_at).getTime() < TURN_STALE_MS;

/** The messages before this turn as text, oldest first. A failed answer has nothing to say, so it stays out. */
async function historyBefore(tx: DbTx, threadId: string, turnId: string): Promise<ClaimedTurn["history"]> {
  const rows = await tx
    .select({ role: miaMessages.role, parts: miaMessages.parts })
    .from(miaMessages)
    .where(and(eq(miaMessages.threadId, threadId), sql`${miaMessages.turnId} <> ${turnId}::uuid`, sql`${miaMessages.status} in ('complete', 'stopped', 'interrupted')`))
    .orderBy(desc(miaMessages.createdAt), desc(miaMessages.id))
    .limit(CHAT_HISTORY);
  const turns = rows
    .reverse()
    .map((row) => ({ role: row.role, content: partsText(row.parts) }))
    .filter((m) => m.content.trim() !== "");
  // A conversation opens with the person's words.
  while (turns[0]?.role === "assistant") turns.shift();
  return turns;
}

async function claimTurn(tx: DbTx, thread: LockedThread, now: Date): Promise<string> {
  const token = randomUUID();
  // An answer left streaming by a turn that died now reads as what it is.
  await tx.update(miaMessages).set({ status: "interrupted" }).where(and(eq(miaMessages.threadId, thread.id), eq(miaMessages.status, "streaming")));
  await tx.update(miaThreads).set({ turnToken: token, turnStartedAt: now, lastMessageAt: now }).where(eq(miaThreads.id, thread.id));
  return token;
}

async function newAnswer(tx: DbTx, organizationId: string, threadId: string, turnId: string, at: Date): Promise<string> {
  const [row] = await tx.insert(miaMessages).values({ organizationId, threadId, turnId, role: "assistant", status: "streaming", parts: [], createdAt: at }).returning({ id: miaMessages.id });
  return row.id;
}

export const drizzleMiaChatStore: MiaChatStore = {
  async createThread(organizationId, userId, personId) {
    try {
      return await db.transaction(async (tx) => {
        const [row] = await tx.insert(miaThreads).values({ organizationId, userId, personId }).returning({ id: miaThreads.id });
        if (personId) await tx.insert(miaThreadPeople).values({ threadId: row.id, personId, organizationId, firstTurnId: null });
        return row;
      });
    } catch (error) {
      if (violatedConstraint(error, "23503")) return null;
      throw error;
    }
  },

  listThreads: (organizationId, userId, limit) =>
    db
      .select(threadColumns)
      .from(miaThreads)
      .where(and(eq(miaThreads.organizationId, organizationId), eq(miaThreads.userId, userId)))
      .orderBy(desc(miaThreads.lastMessageAt), desc(miaThreads.id))
      .limit(limit),

  async thread(organizationId, userId, id) {
    const [row] = await db.select(threadColumns).from(miaThreads).where(owned(organizationId, userId, id));
    return (row as ThreadRow | undefined) ?? null;
  },

  messages: (organizationId, threadId) =>
    db
      .select({ id: miaMessages.id, turnId: miaMessages.turnId, role: miaMessages.role, status: miaMessages.status, parts: miaMessages.parts, error: miaMessages.error, createdAt: miaMessages.createdAt, updatedAt: miaMessages.updatedAt })
      .from(miaMessages)
      .where(and(eq(miaMessages.organizationId, organizationId), eq(miaMessages.threadId, threadId)))
      .orderBy(asc(miaMessages.createdAt), asc(miaMessages.id)) as Promise<MessageRow[]>,

  async rename(organizationId, userId, id, title) {
    const rows = await db.update(miaThreads).set({ title: cleanString(title) }).where(owned(organizationId, userId, id)).returning({ id: miaThreads.id });
    return rows.length > 0;
  },

  async remove(organizationId, userId, id) {
    const rows = await db.delete(miaThreads).where(owned(organizationId, userId, id)).returning({ id: miaThreads.id });
    return rows.length > 0;
  },

  async questionsSince(organizationId, userId, since) {
    const [row] = await db
      .select({ n: count() })
      .from(miaMessages)
      .innerJoin(miaThreads, and(eq(miaThreads.id, miaMessages.threadId), eq(miaThreads.organizationId, miaMessages.organizationId)))
      .where(and(eq(miaMessages.organizationId, organizationId), eq(miaThreads.userId, userId), eq(miaMessages.role, "user"), gte(miaMessages.createdAt, since)));
    return row?.n ?? 0;
  },

  async startTurn(organizationId, userId, threadId, question): Promise<TurnStart> {
    const attempt = () =>
      db.transaction(async (tx): Promise<TurnStart> => {
        const thread = await lockThread(tx, organizationId, userId, threadId);
        if (!thread) return { kind: "gone" };
        // Before the turn check: a second click on Send while the first answers is the same question, not a busy chat.
        const [seen] = (await tx.execute(sql`
          select a.id from mia_messages q join mia_messages a on a.thread_id = q.thread_id and a.turn_id = q.turn_id and a.role = 'assistant'
          where q.thread_id = ${threadId}::uuid and q.client_id = ${question.clientId}
          order by a.created_at desc limit 1`)) as unknown as Array<{ id: string }>;
        if (seen) return { kind: "duplicate", answerId: seen.id };
        if (busy(thread, question.now)) return { kind: "busy" };
        const turnToken = await claimTurn(tx, thread, question.now);
        // Postgres text holds no NUL, so the name and the question are cleaned before either is written.
        const text = cleanString(question.text);
        await tx.update(miaThreads).set({ title: sql`coalesce(${miaThreads.title}, ${threadTitle(text) || null})` }).where(eq(miaThreads.id, threadId));
        const turnId = randomUUID();
        const history = await historyBefore(tx, threadId, turnId);
        await tx.insert(miaMessages).values({ organizationId, threadId, turnId, role: "user", clientId: question.clientId, status: "complete", parts: [{ type: "text", text }], createdAt: question.now });
        // A millisecond later, so the answer sorts after its question.
        const answerId = await newAnswer(tx, organizationId, threadId, turnId, new Date(question.now.getTime() + 1));
        return { kind: "started", turn: { organizationId, userId, threadId, turnId, turnToken, answerId, personId: thread.person_id, history: [...history, { role: "user", content: text }] } };
      });
    try {
      return await attempt();
    } catch (error) {
      // Two clicks that both passed the duplicate check: the second insert loses, and finds the first.
      if (violatedConstraint(error, "23505") === "mia_messages_client_uq") return attempt();
      throw error;
    }
  },

  retryTurn: (organizationId, userId, threadId, now) =>
    db.transaction(async (tx) => {
      const thread = await lockThread(tx, organizationId, userId, threadId);
      if (!thread) return { kind: "gone" as const };
      if (busy(thread, now)) return { kind: "busy" as const };
      const [question] = await tx
        .select({ id: miaMessages.id, turnId: miaMessages.turnId, parts: miaMessages.parts })
        .from(miaMessages)
        .where(and(eq(miaMessages.threadId, threadId), eq(miaMessages.role, "user")))
        .orderBy(desc(miaMessages.createdAt), desc(miaMessages.id))
        .limit(1);
      if (!question) return { kind: "nothing" as const };
      const answers = await tx.select({ id: miaMessages.id, status: miaMessages.status }).from(miaMessages).where(and(eq(miaMessages.threadId, threadId), eq(miaMessages.turnId, question.turnId), eq(miaMessages.role, "assistant")));
      if (answers.some((a) => a.status === "complete")) return { kind: "nothing" as const };
      const turnToken = await claimTurn(tx, thread, now);
      await tx.delete(miaMessages).where(and(eq(miaMessages.threadId, threadId), eq(miaMessages.turnId, question.turnId), eq(miaMessages.role, "assistant")));
      const history = await historyBefore(tx, threadId, question.turnId);
      const answerId = await newAnswer(tx, organizationId, threadId, question.turnId, now);
      const turn: ClaimedTurn = { organizationId, userId, threadId, turnId: question.turnId, turnToken, answerId, personId: thread.person_id, history: [...history, { role: "user", content: partsText(question.parts) }] };
      return { kind: "started" as const, turn };
    }),

  async saveAnswer(turn, parts) {
    const rows = await db
      .update(miaMessages)
      .set({ parts: cleanJson(parts) as ChatPart[] })
      .where(and(eq(miaMessages.id, turn.answerId), eq(miaMessages.status, "streaming")))
      .returning({ id: miaMessages.id });
    return rows.length > 0;
  },

  endTurn: (turn, end) =>
    db.transaction(async (tx) => {
      // The chat's row before the answer's, in the order a turn and a person's delete take them, so neither waits on the other in a cycle.
      await tx
        .update(miaThreads)
        .set({ turnToken: null, turnStartedAt: null, lastMessageAt: end.now })
        .where(and(eq(miaThreads.id, turn.threadId), eq(miaThreads.turnToken, turn.turnToken)));
      const rows = await tx
        .update(miaMessages)
        .set({
          parts: cleanJson(end.parts) as ChatPart[],
          // A Stop that came first keeps its word.
          status: sql`case when ${miaMessages.status} = 'stopped' then 'stopped' else ${end.status} end`,
          usage: end.usage,
          provider: end.provider,
          model: end.model,
          error: end.error === null ? null : cleanString(end.error),
        })
        .where(and(eq(miaMessages.id, turn.answerId), sql`${miaMessages.status} in ('streaming', 'stopped')`))
        .returning({ id: miaMessages.id });
      // The provider charged for the call whatever happened to the answer since.
      if (countedTokens(end.usage) > 0 || (end.usage.cacheReadTokens ?? 0) > 0) await addUsage(tx, turn.organizationId, end.now, end.usage);
      return rows.length > 0;
    }),

  async stop(organizationId, userId, threadId) {
    const rows = (await db.execute(sql`
      update mia_messages m set status = 'stopped', updated_at = now()
      from mia_threads t
      where t.id = m.thread_id and t.organization_id = m.organization_id
        and t.id = ${threadId}::uuid and t.organization_id = ${organizationId}::uuid and t.user_id = ${userId}::uuid
        and m.role = 'assistant' and m.status = 'streaming'
      returning m.id`)) as unknown as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  },

  async linkPeople(turn, personIds) {
    const ids = [...new Set(personIds)].sort();
    if (ids.length === 0) return new Set();
    const list = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const link = () =>
      db.execute(sql`
        insert into mia_thread_people (thread_id, person_id, organization_id, first_turn_id)
        select t.id, p.id, p.organization_id, ${turn.turnId}::uuid
        from people p join mia_threads t on t.id = ${turn.threadId}::uuid and t.organization_id = p.organization_id
        where p.organization_id = ${turn.organizationId}::uuid and p.id in (${list})
        order by p.id
        on conflict (thread_id, person_id) do nothing`);
    try {
      await link();
    } catch (error) {
      // A person deleted between the read and the key check: once more, and the read no longer finds them.
      if (!violatedConstraint(error, "23503")) throw error;
      await link();
    }
    const rows = (await db.execute(sql`
      select tp.person_id from mia_thread_people tp join people p on p.id = tp.person_id and p.organization_id = tp.organization_id
      where tp.thread_id = ${turn.threadId}::uuid and tp.person_id in (${list})`)) as unknown as Array<{ person_id: string }>;
    return new Set(rows.map((r) => r.person_id));
  },
};

/**
 * Deleting people: each chat that read one loses the turns from the first that did, so nothing Mia said about them stays.
 * The chat itself stays, renamed, with a note. Two statements, so a batch of 500 people costs two more. Runs inside the
 * delete's transaction, after the people are locked and before they are deleted; `mia_thread_people` has no cascade, so a
 * delete path that skips this fails.
 */
export async function purgePeopleMiaTx(tx: DbHandle, organizationId: string, personIds: readonly string[]): Promise<void> {
  if (personIds.length === 0) return;
  const list = sql.join(
    [...personIds].map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  // The chats first, in the order a turn takes them (`lockThread`, then its messages). A turn that was writing its question
  // has committed by the time the delete below takes its snapshot, so that question goes too. FOR NO KEY UPDATE leaves
  // the key share that a new link takes, so a tool that links meanwhile waits on the person's lock, not on this one.
  await tx.execute(sql`
    select t.id from mia_threads t
    where t.organization_id = ${organizationId}::uuid
      and t.id in (select tp.thread_id from mia_thread_people tp where tp.organization_id = ${organizationId}::uuid and tp.person_id in (${list}))
    order by t.id
    for no key update`);
  await tx.execute(sql`
    with links as (
      select tp.thread_id, tp.first_turn_id from mia_thread_people tp
      where tp.organization_id = ${organizationId}::uuid and tp.person_id in (${list})
    ), starts as (
      -- A link with no turn, or whose turn retention already removed, takes the whole chat.
      select l.thread_id, min(coalesce((select min(m.created_at) from mia_messages m where m.thread_id = l.thread_id and m.turn_id = l.first_turn_id), '-infinity'::timestamptz)) as since
      from links l group by l.thread_id
    ), dropped as (
      delete from mia_messages m using starts s
      where m.organization_id = ${organizationId}::uuid and m.thread_id = s.thread_id and m.created_at >= s.since
      returning m.thread_id, m.turn_id
    ), unlinked as (
      -- Every part of this statement reads the same snapshot, so links above still sees these rows. Another person first
      -- read in a removed turn is no longer in the chat either, so their link goes too: deleting them later keeps the rest.
      delete from mia_thread_people tp
      where tp.organization_id = ${organizationId}::uuid
        and (tp.person_id in (${list}) or (tp.thread_id, tp.first_turn_id) in (select d.thread_id, d.turn_id from dropped d))
      returning tp.thread_id
    )
    update mia_threads t set title = null, purged_at = now(), updated_at = now()
    where t.organization_id = ${organizationId}::uuid and t.id in (select thread_id from starts)`);
}

/** A member who leaves takes their chats with them, and their Mia jobs that have not started stop. Runs inside the removal. */
export async function releaseMiaOfMemberTx(tx: DbHandle, organizationId: string, userId: string): Promise<void> {
  await tx.execute(sql`delete from mia_threads where organization_id = ${organizationId}::uuid and user_id = ${userId}::uuid`);
  await tx.execute(sql`
    update mia_runs set
      status = case when status = 'running' then status else 'cancelled' end,
      cancel_requested_at = coalesce(cancel_requested_at, now()),
      finished_at = case when status = 'running' then finished_at else now() end,
      claim_token = case when status = 'running' then claim_token else null end,
      checkpoint = case when status = 'running' then checkpoint else null end,
      input = case when status = 'running' then input else '{}'::jsonb end,
      updated_at = now()
    where organization_id = ${organizationId}::uuid and requested_by = ${userId}::uuid and status in ('queued', 'running', 'waiting_limit')`);
}
