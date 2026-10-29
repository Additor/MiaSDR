import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { db, type DbHandle } from "@/platform/db/client";
import { HELD_LOCK_TIMEOUT, setLockTimeout } from "@/platform/db/person-locks";
import { lockPersonOutreachTx } from "@/platform/db/person-locks";
import { endRunCountingTx, OPEN_STEPS, RETIRABLE_DRAFTS, type Tx } from "../after-reply/infrastructure/sequence-stop";
import { conversations, events, records } from "@/platform/db/schema";
import type { Actor } from "@/shared/errors";
import { AI_JOB_LEASE_MS } from "../ai/application/ai-jobs";
import type { PersonChannel, PersonEventInput, PersonEventView, PersonReplyHandling, PersonRunStop } from "../application/person-ports";
import { publicConversation, publicConversationSql, visibleRecordSql } from "@/platform/db/conversation-visibility";
import { rowsOf, uuidList } from "@/platform/db/sql-values";

/**
 * Callee-owned functions for turning a lead into a contact. The people context runs the conversion and calls these in
 * its transaction; the caller holds the transaction, so every function here takes it (or reads without one).
 */

const MAX_EVENTS = 500;

/**
 * The person's records `FOR NO KEY UPDATE` in id order, then the person's outreach advisory lock. Single-person reply ingest and
 * do-not-contact take the same locks in the same order. A caller passes an open transaction: the locks last until it ends.
 */
export async function lockPersonRecords(tx: DbHandle, organizationId: string, personId: string): Promise<void> {
  await lockPersonRecordRows(tx, organizationId, personId);
  await lockPersonOutreachTx(tx as Tx, organizationId, [personId]);
}

/**
 * The first half of `lockPersonRecords`: the person's records in id order. Returns how many it locked. Writers take
 * `no key update`, which lets a draft or message insert's key share through; a contact delete takes `update`, because it
 * deletes the rows (docs/database.md, "Lock modes").
 */
export async function lockPersonRecordRows(tx: DbHandle, organizationId: string, personId: string, strength: "update" | "no key update" = "no key update"): Promise<number> {
  const rows = await tx.select({ id: records.id }).from(records).where(and(eq(records.organizationId, organizationId), eq(records.personId, personId))).orderBy(records.id).for(strength);
  return rows.length;
}

/**
 * Ends the person's active and paused runs with `reason`. Each run ends through the one statement every stop uses, which
 * returns the drafts it retired, so `drafts` is exact and counted in the caller's transaction. The caller has taken
 * `lockPersonRecords`, so no run starts or draft links in between.
 */
export async function interruptPersonRuns(tx: DbHandle, input: { organizationId: string; personId: string; reason: "converted"; now: Date }): Promise<PersonRunStop> {
  const handle = tx as Tx;
  const runs = rowsOf<{ id: string }>(
    await handle.execute(sql`
      select r.id from sequence_runs r join records rec on rec.id = r.record_id and rec.organization_id = r.organization_id
      where r.organization_id = ${input.organizationId} and rec.person_id = ${input.personId}::uuid and r.status in ('active', 'paused')
      order by r.id`),
  );
  const stopped: PersonRunStop = { runs: 0, drafts: 0 };
  for (const run of runs) {
    const ended = await endRunCountingTx(handle, { organizationId: input.organizationId, runId: run.id, final: "interrupted", reason: input.reason, now: input.now });
    if (!ended) continue;
    stopped.runs += 1;
    stopped.drafts += ended.draftsRetired;
  }
  return stopped;
}

/** What `interruptPersonRuns` would change for each person, from the same predicates `endRunCountingTx` uses. */
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
                 and (d.id in (select ssr.draft_id from sequence_step_runs ssr where ssr.sequence_run_id = r.id and ssr.draft_id is not null and ssr.status in ${OPEN_STEPS})
                      or d.request->>'sequenceRunId' = r.id::text)
             )), 0)::int as drafts
      from sequence_runs r join records rec on rec.id = r.record_id and rec.organization_id = r.organization_id
      where r.organization_id = ${organizationId} and rec.person_id in (${ids}) and r.status in ('active', 'paused')
      group by rec.person_id`),
  );
  for (const row of rows) result.set(row.person_id, { runs: row.runs, drafts: row.drafts });
  return result;
}

/** Writes one event about a person. `recordId` may be null: the conversion event belongs to the person, not to a reply record. */
export async function appendPersonEvent(tx: DbHandle, input: PersonEventInput): Promise<void> {
  await tx.insert(events).values({
    organizationId: input.organizationId,
    personId: input.personId,
    recordId: input.recordId ?? null,
    eventType: input.eventType,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    fromData: input.fromData ?? null,
    toData: input.toData ?? null,
    meta: (input.meta ?? {}) as Record<string, unknown>,
  });
}

export async function activeConversationOfPerson(organizationId: string, personId: string): Promise<{ conversationId: string; channel: PersonChannel } | null> {
  const [row] = await db
    .select({ id: conversations.id, channel: conversations.channel })
    .from(conversations)
    .innerJoin(records, and(eq(records.id, conversations.recordId), eq(records.organizationId, conversations.organizationId)))
    .where(and(eq(conversations.organizationId, organizationId), eq(records.personId, personId), publicConversation))
    .orderBy(sql`(${conversations.channel} = ${records.activeChannel}) desc nulls last`, desc(conversations.updatedAt), conversations.id)
    .limit(1);
  return row ? { conversationId: row.id, channel: row.channel as PersonChannel } : null;
}

/**
 * Where an old `/crm/records/[id]` link lands: the active-channel public conversation of the record's person
 * (`activeConversationOfPerson`). Null for an unknown record, another organization's record, or a person whose
 * threads are all private.
 */
export async function activeConversationOfRecord(organizationId: string, recordId: string): Promise<{ conversationId: string; channel: PersonChannel } | null> {
  const [row] = await db
    .select({ personId: records.personId })
    .from(records)
    .where(and(eq(records.organizationId, organizationId), eq(records.id, recordId)));
  return row ? activeConversationOfPerson(organizationId, row.personId) : null;
}

export async function listPersonEvents(organizationId: string, personId: string, limit: number): Promise<PersonEventView[]> {
  const rows = await db
    .select({
      id: events.id,
      eventType: events.eventType,
      actorType: events.actorType,
      createdAt: events.createdAt,
      recordId: events.recordId,
      meta: events.meta,
      fromData: events.fromData,
      toData: events.toData,
    })
    .from(events)
    .leftJoin(records, and(eq(records.id, events.recordId), eq(records.organizationId, events.organizationId)))
    .where(and(eq(events.organizationId, organizationId), eq(events.personId, personId), or(isNull(events.recordId), visibleRecordSql("records"))))
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
 * Step 1 of the conversion, the order of `lockPersonRecords`: the person's records `FOR NO KEY UPDATE` in id order (waiting up to 5 s,
 * holding nothing), then the person's outreach advisory lock. Single-person ingest takes the same order. Do not contact
 * (`setDoNotContact`) takes another: `dnc:{personId}`, its `contact_policies` row through the upsert, then the records, runs
 * and enrollments, so it holds the policy row while it waits on the records. A contact delete locks the records first and the
 * policy row later; when the two meet, the delete's held-lock timeout makes it give way and run once more.
 */
export async function lockPersonForConversion(tx: DbHandle, organizationId: string, personId: string): Promise<void> {
  const locked = await lockPersonRecordRows(tx, organizationId, personId);
  if (locked > 0) await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
  await lockPersonOutreachTx(tx as Tx, organizationId, [personId]);
  await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
}

/**
 * Step 1 of a contact delete: the person's records `FOR UPDATE` in id order, then the conversations of those records
 * `FOR UPDATE` in id order, then the person's outreach advisory lock. The conversation locks keep a reply from adding a
 * message between the purge's message and conversation deletes: a message insert needs `FOR KEY SHARE` on its
 * conversation. The ids are locked, not read, so private threads lock too. Once the first lock is held the transaction
 * waits at most `HELD_LOCK_TIMEOUT` for the next, so a writer with another order wins and the delete retries.
 */
export async function lockPersonForDelete(tx: DbHandle, organizationId: string, personId: string): Promise<void> {
  const locked = await lockPersonRecordRows(tx, organizationId, personId, "update");
  if (locked > 0) {
    await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
    await tx.execute(sql`
      select c.id from conversations c
      where c.organization_id = ${organizationId} and c.record_id in (select r.id from records r where r.organization_id = ${organizationId} and r.person_id = ${personId}::uuid)
      order by c.id for update of c`);
  }
  await lockPersonOutreachTx(tx as Tx, organizationId, [personId]);
  await setLockTimeout(tx, HELD_LOCK_TIMEOUT);
}

export interface PersonHandlingCounts {
  conversations: number;
  messages: number;
  events: number;
  notes: number;
  tasks: number;
  /** The person has a conversation the actor cannot see, which the counts leave out. */
  hidden: boolean;
}

export type PersonHandlingBlocker = { reason: "send_in_flight" } | { reason: "ai_job_running" } | { reason: "private_conversation" };

const personRecords = (organizationId: string, personId: string) =>
  sql`(select r.id from records r where r.organization_id = ${organizationId} and r.person_id = ${personId}::uuid)`;

/**
 * Whether the actor sees conversation `alias`: an owner or admin sees every conversation, a member sees public ones and the
 * private threads of personal campaigns they created.
 */
const seenBy = (actor: Actor, alias: string) =>
  isOwnerOrAdmin(actor.role)
    ? sql`true`
    : sql`(${publicConversationSql(alias)} or exists (select 1 from campaigns pc where pc.id = ${sql.raw(alias)}.private_campaign_id and pc.organization_id = ${sql.raw(alias)}.organization_id and pc.created_by = ${actor.userId}::uuid))`;

/**
 * What a contact delete removes in this context, as the actor may see it. The sets match `purgePersonHandling`: events of
 * the person or of their records, notes and tasks of the person, the conversations of their records and their messages.
 * A record whose conversations are all hidden from the actor takes its events, notes and tasks out of the counts.
 */
export async function personHandlingCounts(tx: DbHandle, actor: Actor, personId: string): Promise<PersonHandlingCounts> {
  const org = actor.organizationId;
  const recs = personRecords(org, personId);
  const [row] = rowsOf<PersonHandlingCounts>(
    await tx.execute(sql`
      with convs as (
        select c.id, c.record_id, ${seenBy(actor, "c")} as seen from conversations c where c.organization_id = ${org} and c.record_id in ${recs}
      ),
      hidden_records as (select record_id from convs group by record_id having not bool_or(seen))
      select
        (select count(*) from convs where seen)::int as conversations,
        (select count(*) from messages m where m.organization_id = ${org} and m.conversation_id in (select id from convs where seen))::int as messages,
        (select count(*) from events e where e.organization_id = ${org} and (e.person_id = ${personId}::uuid or e.record_id in ${recs})
          and (e.record_id is null or e.record_id not in (select record_id from hidden_records)))::int as events,
        (select count(*) from notes n where n.organization_id = ${org} and n.person_id = ${personId}::uuid
          and (n.record_id is null or n.record_id not in (select record_id from hidden_records)))::int as notes,
        (select count(*) from tasks t where t.organization_id = ${org} and t.person_id = ${personId}::uuid
          and (t.record_id is null or t.record_id not in (select record_id from hidden_records)))::int as tasks,
        exists (select 1 from convs where not seen) as hidden`),
  );
  return row;
}

/**
 * Step 6 of a contact delete. `send_in_flight`: a reply send of the person's drafts is prepared, sending or uncertain.
 * `ai_job_running`: an AI job holds a live lease on a message or classification of the person's records; a job whose lease
 * ran out does not block, and the purge deletes it. `private_conversation`: for a member, the person has a thread in a
 * personal campaign of another member. Owners and admins pass that rule.
 */
export async function personHandlingBlockers(tx: DbHandle, actor: Actor, personId: string): Promise<PersonHandlingBlocker[]> {
  const org = actor.organizationId;
  const recs = personRecords(org, personId);
  const leaseSeconds = AI_JOB_LEASE_MS / 1000;
  const [row] = rowsOf<{ send_in_flight: boolean; ai_job_running: boolean; private_conversation: boolean }>(
    await tx.execute(sql`
      select
        exists (
          select 1 from send_attempts sa join drafts d on d.id = sa.draft_id and d.organization_id = sa.organization_id
          where d.organization_id = ${org} and d.record_id in ${recs} and sa.status in ('prepared', 'sending', 'delivery_uncertain')
        ) as send_in_flight,
        exists (
          select 1 from ai_jobs j
          where j.organization_id = ${org} and j.status = 'running' and j.locked_at > now() - make_interval(secs => ${leaseSeconds})
            and ((j.kind = 'classification' and j.entity_type = 'message' and j.entity_id in (
                   select m.id from messages m join conversations mc on mc.id = m.conversation_id and mc.organization_id = m.organization_id
                   where m.organization_id = ${org} and mc.record_id in ${recs}))
              or (j.kind = 'initial_draft' and j.entity_type = 'classification' and j.entity_id in (
                   select k.id from reply_type_picks k where k.organization_id = ${org} and k.record_id in ${recs})))
        ) as ai_job_running,
        exists (
          select 1 from conversations c where c.organization_id = ${org} and c.record_id in ${recs} and not ${seenBy(actor, "c")}
        ) as private_conversation`),
  );
  const blockers: PersonHandlingBlocker[] = [];
  if (row.send_in_flight) blockers.push({ reason: "send_in_flight" });
  if (row.ai_job_running) blockers.push({ reason: "ai_job_running" });
  if (row.private_conversation) blockers.push({ reason: "private_conversation" });
  return blockers;
}

/**
 * The lead delete's history rule, for a batch in one statement: the people among `personIds` with a reply-handling record or
 * an event. A lead with either stays (`linked_records`). The caller holds the people rows `FOR UPDATE`, so a record or event
 * insert, which needs `FOR KEY SHARE` on its person, either committed before this read or waits for the delete.
 */
export async function peopleWithHistory(tx: DbHandle, organizationId: string, personIds: readonly string[]): Promise<Set<string>> {
  if (personIds.length === 0) return new Set();
  const ids = uuidList(personIds);
  const rows = rowsOf<{ person_id: string }>(
    await tx.execute(sql`
      select r.person_id from records r where r.organization_id = ${organizationId} and r.person_id in ${ids}
      union
      select e.person_id from events e where e.organization_id = ${organizationId} and e.person_id in ${ids}`),
  );
  return new Set(rows.map((row) => row.person_id));
}

export const personReplyHandling: PersonReplyHandling ={ lockPersonRecords, lockPersonRecordRows, interruptPersonRuns, previewPersonRunStop, appendPersonEvent, activeConversationOfPerson, listPersonEvents };
