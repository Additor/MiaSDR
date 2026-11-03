import { and, desc, eq, sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { HELD_LOCK_TIMEOUT, setLockTimeout } from "@/platform/db/person-locks";
import { lockPersonOutreachTx } from "@/platform/db/person-locks";
import { OPEN_STEPS, RETIRABLE_DRAFTS, type Tx } from "../after-reply/infrastructure/follow-up-stop";
import { threads, events, conversations } from "@/platform/db/schema";
import { AI_JOB_LEASE_MS } from "../ai/application/ai-jobs";
import type { PersonChannel, PersonEventInput, PersonEventView, PersonReplyHandling, PersonRunStop } from "../application/person-ports";
import { rowsOf, uuidList } from "@/platform/db/sql-values";

/**
 * Callee-owned functions for turning a lead into a contact. The people context runs the conversion and calls these in
 * its transaction; the caller holds the transaction, so every function here takes it (or reads without one).
 */

const MAX_EVENTS = 500;

/**
 * The person's conversations `FOR NO KEY UPDATE` in id order, then the person's outreach advisory lock. A caller passes an open transaction: the locks last until it ends.
 */
export async function lockPersonConversations(tx: DbHandle, organizationId: string, personId: string): Promise<void> {
  await lockPersonConversationRows(tx, organizationId, personId);
  await lockPersonOutreachTx(tx as Tx, organizationId, [personId]);
}

/**
 * The first half of `lockPersonConversations`: the person's conversations in id order. Returns how many it locked. Writers take
 * `no key update`, which lets a draft or message insert's key share through; a contact delete takes `update`, because it
 * deletes the rows (docs/database.md, "Lock modes").
 */
export async function lockPersonConversationRows(tx: DbHandle, organizationId: string, personId: string, strength: "update" | "no key update" = "no key update"): Promise<number> {
  const rows = await tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.organizationId, organizationId), eq(conversations.personId, personId))).orderBy(conversations.id).for(strength);
  return rows.length;
}

/** What the conversion's stop would change for each person, from the same predicates `endRunCountingTx` uses. */
export async function previewPersonRunStop(organizationId: string, personIds: string[]): Promise<Map<string, PersonRunStop>> {
  const result = new Map<string, PersonRunStop>(personIds.map((id) => [id, { runs: 0, drafts: 0 }]));
  if (personIds.length === 0) return result;
  const ids = sql.join(personIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = rowsOf<{ person_id: string; runs: number; drafts: number }>(
    await db.execute(sql`
      select rec.person_id, count(*)::int as runs,
             coalesce(sum((
               select count(*) from drafts d
               where d.organization_id = r.organization_id and d.status in ${RETIRABLE_DRAFTS}
                 and (d.id in (select ssr.draft_id from follow_up_step_runs ssr where ssr.follow_up_run_id = r.id and ssr.draft_id is not null and ssr.status in ${OPEN_STEPS})
                      or d.request->>'followUpRunId' = r.id::text)
             )), 0)::int as drafts
      from follow_up_runs r join conversations rec on rec.id = r.conversation_id and rec.organization_id = r.organization_id
      where r.organization_id = ${organizationId} and rec.person_id in (${ids}) and r.status in ('active', 'paused')
      group by rec.person_id`),
  );
  for (const row of rows) result.set(row.person_id, { runs: row.runs, drafts: row.drafts });
  return result;
}

/** Writes one event about a person. `conversationId` may be null: the conversion event belongs to the person, not to a conversation. */
export async function appendPersonEvent(tx: DbHandle, input: PersonEventInput): Promise<void> {
  await tx.insert(events).values({
    organizationId: input.organizationId,
    personId: input.personId,
    conversationId: input.conversationId ?? null,
    eventType: input.eventType,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    fromData: input.fromData ?? null,
    toData: input.toData ?? null,
    meta: (input.meta ?? {}) as Record<string, unknown>,
  });
}

export async function activeThreadOfPerson(organizationId: string, personId: string): Promise<{ threadId: string; channel: PersonChannel } | null> {
  const [row] = await db
    .select({ id: threads.id, channel: threads.channel })
    .from(threads)
    .innerJoin(conversations, and(eq(conversations.id, threads.conversationId), eq(conversations.organizationId, threads.organizationId)))
    .where(and(eq(threads.organizationId, organizationId), eq(conversations.personId, personId)))
    .orderBy(sql`(${threads.channel} = ${conversations.activeChannel}) desc nulls last`, desc(threads.updatedAt), threads.id)
    .limit(1);
  return row ? { threadId: row.id, channel: row.channel as PersonChannel } : null;
}

export async function listPersonEvents(organizationId: string, personId: string, limit: number): Promise<PersonEventView[]> {
  const rows = await db
    .select({
      id: events.id,
      eventType: events.eventType,
      actorType: events.actorType,
      createdAt: events.createdAt,
      conversationId: events.conversationId,
      meta: events.meta,
      fromData: events.fromData,
      toData: events.toData,
    })
    .from(events)
    .where(and(eq(events.organizationId, organizationId), eq(events.personId, personId)))
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(Math.min(Math.max(Math.trunc(limit), 1), MAX_EVENTS));
  return rows;
}

/*
 * Callee-owned functions for deleting a contact ("Contacts and Companies CRUD" in docs/decisions.md). The
 * leads use case holds the transaction and calls these in this order: `lockPersonForDelete` first, then the people row,
 * then people's do not contact lock, then the blockers and counts, then `purgePersonHandling` (person-purge.ts).
 */

/**
 * Step 1 of the conversion, the order of `lockPersonConversations`: the person's conversations `FOR NO KEY UPDATE` in id order (waiting up to 5 s,
 * holding nothing), then the person's outreach advisory lock. Single-person ingest and `stopContactTx` take the same order, and
 * do not contact writes its `contact_policies` row after both, as a contact delete locks it after both.
 */
export async function lockPersonForConversion(tx: DbHandle, organizationId: string, personId: string): Promise<void> {
  const locked = await lockPersonConversationRows(tx, organizationId, personId);
  if (locked > 0) await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
  await lockPersonOutreachTx(tx as Tx, organizationId, [personId]);
  await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
}

/**
 * Step 1 of a contact delete: the person's conversations `FOR UPDATE` in id order, then the conversations of those conversations
 * `FOR UPDATE` in id order, then the person's outreach advisory lock. The conversation locks keep a reply from adding a
 * message between the purge's message and conversation deletes: a message insert needs `FOR KEY SHARE` on its
 * conversation. Once the first lock is held the transaction
 * waits at most `HELD_LOCK_TIMEOUT` for the next, so a writer with another order wins and the delete retries.
 */
export async function lockPersonForDelete(tx: DbHandle, organizationId: string, personId: string): Promise<void> {
  const locked = await lockPersonConversationRows(tx, organizationId, personId, "update");
  if (locked > 0) {
    await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
    await tx.execute(sql`
      select c.id from threads c
      where c.organization_id = ${organizationId} and c.conversation_id in (select r.id from conversations r where r.organization_id = ${organizationId} and r.person_id = ${personId}::uuid)
      order by c.id for update of c`);
  }
  await lockPersonOutreachTx(tx as Tx, organizationId, [personId]);
  await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
}

export interface PersonHandlingCounts {
  threads: number;
  messages: number;
  events: number;
  notes: number;
  tasks: number;
  /** The person has a conversation the actor cannot see, which the counts leave out. */
  hidden: boolean;
}

export type PersonHandlingBlocker = { reason: "send_in_flight" } | { reason: "ai_job_running" };

const personConversations = (organizationId: string, personId: string) =>
  sql`(select r.id from conversations r where r.organization_id = ${organizationId} and r.person_id = ${personId}::uuid)`;

/**
 * What a contact delete removes in this context. The sets match `purgePersonHandling`: events of the person or of their
 * conversations, notes and tasks of the person, the threads of their conversations and their messages.
 */
export async function personHandlingCounts(tx: DbHandle, org: string, personId: string): Promise<PersonHandlingCounts> {
  const recs = personConversations(org, personId);
  const [row] = rowsOf<PersonHandlingCounts>(
    await tx.execute(sql`
      with convs as (
        select c.id from threads c where c.organization_id = ${org} and c.conversation_id in ${recs}
      )
      select
        (select count(*) from convs)::int as threads,
        (select count(*) from messages m where m.organization_id = ${org} and m.thread_id in (select id from convs))::int as messages,
        (select count(*) from events e where e.organization_id = ${org} and (e.person_id = ${personId}::uuid or e.conversation_id in ${recs}))::int as events,
        (select count(*) from notes n where n.organization_id = ${org} and n.person_id = ${personId}::uuid)::int as notes,
        (select count(*) from tasks t where t.organization_id = ${org} and t.person_id = ${personId}::uuid)::int as tasks`),
  );
  return row;
}

/**
 * Step 6 of a contact delete. `send_in_flight`: a reply send of the person's drafts is prepared, sending or uncertain.
 * `ai_job_running`: an AI job holds a live lease on a message or classification of the person's conversations; a job whose lease
 * ran out does not block, and the purge deletes it.
 */
export async function personHandlingBlockers(tx: DbHandle, org: string, personId: string): Promise<PersonHandlingBlocker[]> {
  const recs = personConversations(org, personId);
  const leaseSeconds = AI_JOB_LEASE_MS / 1000;
  const [row] = rowsOf<{ send_in_flight: boolean; ai_job_running: boolean }>(
    await tx.execute(sql`
      select
        exists (
          select 1 from send_attempts sa join drafts d on d.id = sa.draft_id and d.organization_id = sa.organization_id
          where d.organization_id = ${org} and d.conversation_id in ${recs} and sa.status in ('prepared', 'sending', 'delivery_uncertain')
        ) as send_in_flight,
        exists (
          select 1 from ai_jobs j
          where j.organization_id = ${org} and j.status = 'running' and j.locked_at > now() - make_interval(secs => ${leaseSeconds})
            and ((j.kind = 'classification' and j.entity_type = 'message' and j.entity_id in (
                   select m.id from messages m join threads mc on mc.id = m.thread_id and mc.organization_id = m.organization_id
                   where m.organization_id = ${org} and mc.conversation_id in ${recs}))
              or (j.kind = 'initial_draft' and j.entity_type = 'classification' and j.entity_id in (
                   select k.id from reply_type_picks k where k.organization_id = ${org} and k.conversation_id in ${recs})))
        ) as ai_job_running`),
  );
  const blockers: PersonHandlingBlocker[] = [];
  if (row.send_in_flight) blockers.push({ reason: "send_in_flight" });
  if (row.ai_job_running) blockers.push({ reason: "ai_job_running" });
  return blockers;
}

/**
 * The lead delete's history rule, for a batch in one statement: the people among `personIds` with a reply-handling conversation or
 * an event. A lead with either stays (`linked_conversations`). The caller holds the people rows `FOR UPDATE`, so a conversation or event
 * insert, which needs `FOR KEY SHARE` on its person, either committed before this read or waits for the delete.
 */
export async function peopleWithHistory(tx: DbHandle, organizationId: string, personIds: readonly string[]): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const ids = uuidList(personIds);
  const rows = rowsOf<{ person_id: string }>(
    await tx.execute(sql`
      select r.person_id from conversations r where r.organization_id = ${organizationId} and r.person_id in ${ids}
      union
      select e.person_id from events e where e.organization_id = ${organizationId} and e.person_id in ${ids}`),
  );
  return new Set(rows.map((row) => row.person_id));
}

export const personReplyHandling: PersonReplyHandling ={ lockPersonConversations, lockPersonConversationRows, previewPersonRunStop, appendPersonEvent, activeThreadOfPerson, listPersonEvents };
