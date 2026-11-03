import { sql, type SQL } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { AI_JOB_LEASE_MS } from "../ai/application/ai-jobs";
import { rowsOf } from "@/platform/db/sql-values";

/**
 * Step 10 of a contact delete ("Contacts and Companies CRUD" in docs/decisions.md): removes everything this context holds
 * about one person. The leads use case calls it inside its transaction after `lockPersonForDelete`, the people row lock,
 * the do not contact row lock and the blockers, so no reply, draft or AI job of the person lands while it runs.
 *
 * `events` and `messages` are append-only (trigger function `ledger_reject_delete`). This function alone turns the purge
 * switch `miasdr.allow_purge` on for its own deletes and off before it returns; allow-purge-scope.test.ts fails when any
 * other source file sets it. The switch is transaction-local, so an error that aborts the transaction drops it too.
 *
 * Every statement filters by the organization and by the person's conversations, so another person's rows stay. Private
 * conversations go with the person: the delete is not a read, and the use case blocks a member who cannot see them.
 */

export interface PersonHandlingPurge {
  conversations: number;
  threads: number;
  messages: number;
  events: number;
}

const deleted = async (tx: DbHandle, statement: SQL) =>
  rowsOf<{ n: number }>(await tx.execute(sql`with d as (${statement} returning 1) select count(*)::int as n from d`))[0].n;

export async function purgePersonHandling(tx: DbHandle, organizationId: string, personId: string): Promise<PersonHandlingPurge> {
  const org = organizationId;
  const recs = sql`(select r.id from conversations r where r.organization_id = ${org} and r.person_id = ${personId}::uuid)`;
  const convs = sql`(select c.id from threads c where c.organization_id = ${org} and c.conversation_id in ${recs})`;
  const msgs = sql`(select m.id from messages m where m.organization_id = ${org} and m.thread_id in ${convs})`;
  const leaseSeconds = AI_JOB_LEASE_MS / 1000;

  await tx.execute(sql`select set_config('miasdr.allow_purge', 'on', true)`);
  // Foreign key order: each delete removes the last rows that point at the next table.
  await tx.execute(sql`
    delete from ai_jobs j
    where j.organization_id = ${org}
      and not (j.status = 'running' and j.locked_at > now() - make_interval(secs => ${leaseSeconds}))
      and ((j.kind = 'classification' and j.entity_type = 'message' and j.entity_id in ${msgs})
        or (j.kind = 'initial_draft' and j.entity_type = 'classification'
            and j.entity_id in (select k.id from reply_type_picks k where k.organization_id = ${org} and k.conversation_id in ${recs})))`);
  // Cascades to follow_up_step_runs, which hold the drafts and sent messages of the runs.
  await tx.execute(sql`delete from follow_up_runs where organization_id = ${org} and conversation_id in ${recs}`);
  await tx.execute(sql`
    delete from send_attempts where organization_id = ${org}
      and draft_id in (select d.id from drafts d where d.organization_id = ${org} and d.conversation_id in ${recs})`);
  await tx.execute(sql`delete from drafts where organization_id = ${org} and conversation_id in ${recs}`);
  await tx.execute(sql`delete from reply_type_picks where organization_id = ${org} and conversation_id in ${recs}`);
  const events = await deleted(tx, sql`delete from events where organization_id = ${org} and (person_id = ${personId}::uuid or conversation_id in ${recs})`);
  // Cascades to the lead_ccs rows these messages sourced; other rows that named them as the latest inbound message or as
  // the reply target get null.
  const messages = await deleted(tx, sql`delete from messages where organization_id = ${org} and thread_id in ${convs}`);
  const threads = await deleted(tx, sql`delete from threads where organization_id = ${org} and conversation_id in ${recs}`);
  // Notes and tasks on these conversations get a null conversation and stay with the person, whose delete removes them.
  const conversations = await deleted(tx, sql`delete from conversations where organization_id = ${org} and person_id = ${personId}::uuid`);
  await tx.execute(sql`select set_config('miasdr.allow_purge', 'off', true)`);
  return { conversations, threads, messages, events };
}

/** The purge switch as the transaction sees it, for callers and tests that check it is off. */
export async function purgeSwitchIsOn(tx: DbHandle): Promise<boolean> {
  const [row] = rowsOf<{ on: boolean }>(await tx.execute(sql`select coalesce(current_setting('miasdr.allow_purge', true), '') = 'on' as on`));
  return row.on;
}
