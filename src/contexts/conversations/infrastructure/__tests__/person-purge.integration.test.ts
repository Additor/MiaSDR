import { sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { describeDb, dropOrgs, TEST_DATABASE_URL, testSql, uniqueKey, useTestEnv } from "@/test-support/db";

/**
 * The conversations side of a contact delete ("Contacts and Companies CRUD" in docs/decisions.md): the delete locks,
 * the counts and blockers as the actor sees them, and `purgePersonHandling`. Needs TEST_DATABASE_URL pointing at a
 * migrated Postgres.
 */
describeDb("contact delete: conversations locks, counts, blockers and purge", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let handling: typeof import("../person-handling");
  let purge: typeof import("../person-purge");
  let db: typeof import("@/platform/db/client").db;
  const orgs: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    handling = await import("../person-handling");
    purge = await import("../person-purge");
    db = (await import("@/platform/db/client")).db;
  });

  afterAll(async () => {
    await dropOrgs(
      sql,
      orgs.map((organizationId) => ({ organizationId })),
      users,
    );
    await sql.end();
  });

  const one = async (rows: PromiseLike<Array<{ id: string }>>) => (await rows)[0].id as string;

  async function organization() {
    const tag = uniqueKey();
    const org = await one(sql`insert into organizations (name, slug) values ('Purge', ${"purge-" + tag}) returning id`);
    orgs.push(org);
    const user = async (name: string) => {
      const id = await one(sql`insert into users (name, email) values (${name}, ${`${name}-${tag}@x.test`}) returning id`);
      users.push(id);
      return id;
    };
    const member = await user("member");
    const other = await user("other");
    const admin = await user("admin");
    const typeSet = await one(sql`insert into reply_type_sets (organization_id, name, is_default) values (${org}, 'p', true) returning id`);
    // A person has one conversation per reply type set, so the private conversation of `contact` lives in a second typeSet.
    const typeSet2 = await one(sql`insert into reply_type_sets (organization_id, name, is_default) values (${org}, 'p2', false) returning id`);
    const sub = await one(sql`insert into reply_types (organization_id, reply_type_set_id, group_key, key, name) values (${org}, ${typeSet}, 'interested', 'a', 'A') returning id`);
    const actors = {
      member: { userId: member, organizationId: org, role: "member" } satisfies Actor,
      other: { userId: other, organizationId: org, role: "member" } satisfies Actor,
      admin: { userId: admin, organizationId: org, role: "admin" } satisfies Actor,
    };
    return { org, tag, typeSet, typeSet2, sub, actors };
  }
  type Org = Awaited<ReturnType<typeof organization>>;

  /**
   * A contact with a row in every table the purge touches: one conversation with a public email thread (two messages, a
   * classification, AI jobs, a draft with a send attempt, a follow-up run with a step run, a follow-up choice), events on
   * the person and on the conversation, notes and tasks on both, a do-not-contact row and a resolved identity exception. On
   * request, a second conversation with a thread of its own.
   */
  async function contact(o: Org, label: string, opts: { secondConversation?: boolean } = {}) {
    const t = `${o.tag}-${label}`;
    const person = await one(sql`
      insert into people (organization_id, email, full_name, lifecycle, converted_at) values (${o.org}, ${`${t}@lead.test`}, ${label}, 'contact', now()) returning id`);
    const conversation = await one(sql`insert into conversations (organization_id, person_id, reply_type_set_id) values (${o.org}, ${person}, ${o.typeSet}) returning id`);
    const mailbox = `me-${t}@x.test`;
    const thread = await one(sql`insert into threads (organization_id, conversation_id, channel, account_ref) values (${o.org}, ${conversation}, 'email', ${mailbox}) returning id`);
    const inbound = await one(sql`
      insert into messages (organization_id, thread_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${o.org}, ${thread}, 'email', ${mailbox}, 'inbound', ${`in-${t}`}, 'hello', now()) returning id`);
    const outbound = await one(sql`
      insert into messages (organization_id, thread_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${o.org}, ${thread}, 'email', ${mailbox}, 'outbound', ${`out-${t}`}, 'reply', now()) returning id`);
    await sql`update conversations set latest_inbound_message_id = ${inbound} where id = ${conversation}`;
    const classification = await one(sql`
      insert into reply_type_picks (organization_id, conversation_id, message_id, expected_context_version, previous_reply_type_id, proposed_reply_type_id, applied_reply_type_id, confidence)
      values (${o.org}, ${conversation}, ${inbound}, 0, ${o.sub}, ${o.sub}, ${o.sub}, 0.9) returning id`);
    await sql`insert into ai_jobs (organization_id, kind, status, entity_type, entity_id, idempotency_key, completed_at) values (${o.org}, 'classification', 'succeeded', 'message', ${inbound}, ${`job-c-${t}`}, now())`;
    await sql`insert into ai_jobs (organization_id, kind, status, entity_type, entity_id, idempotency_key) values (${o.org}, 'initial_draft', 'queued', 'classification', ${classification}, ${`job-d-${t}`})`;
    const draft = await one(sql`
      insert into drafts (organization_id, conversation_id, thread_id, reply_for_message_id, expected_context_version, channel)
      values (${o.org}, ${conversation}, ${thread}, ${inbound}, 0, 'email') returning id`);
    const attempt = await one(sql`
      insert into send_attempts (organization_id, draft_id, idempotency_key, actor_user_id, status) values (${o.org}, ${draft}, ${`sa-${t}`}, ${o.actors.member.userId}, 'prepared') returning id`);
    await sql`update send_attempts set status = 'sent' where id = ${attempt}`;
    const flow = await one(sql`insert into follow_up_flows (organization_id, name) values (${o.org}, ${`Seq ${t}`}) returning id`);
    const version = await one(sql`insert into follow_up_versions (organization_id, flow_id, version) values (${o.org}, ${flow}, 1) returning id`);
    const step = await one(sql`
      insert into follow_up_steps (organization_id, follow_up_version_id, position, step_type, name, delay_minutes, ai_instructions)
      values (${o.org}, ${version}, 1, 'reply', 'Step 1', 0, 'Write a short note.') returning id`);
    await sql`update follow_up_versions set status = 'published', published_at = now() where id = ${version}`;
    const run = await one(sql`
      insert into follow_up_runs (organization_id, conversation_id, thread_id, flow_id, follow_up_version_id, reply_type_id, status, started_by, trigger_message_id, last_inbound_at_start)
      values (${o.org}, ${conversation}, ${thread}, ${flow}, ${version}, ${o.sub}, 'completed', 'ai_assignment', ${inbound}, now()) returning id`);
    await sql`
      insert into follow_up_step_runs (organization_id, follow_up_run_id, follow_up_step_id, status, due_at, draft_id, sent_message_id, expected_context_version)
      values (${o.org}, ${run}, ${step}, 'sent', now(), ${draft}, ${outbound}, 0)`;
    await sql`insert into events (organization_id, person_id, conversation_id, event_type, actor_type) values (${o.org}, ${person}, ${conversation}, 'reply_type.changed', 'system')`;
    await sql`insert into events (organization_id, person_id, event_type, actor_type) values (${o.org}, ${person}, 'lifecycle.converted', 'system')`;
    await sql`insert into notes (organization_id, person_id, conversation_id, body) values (${o.org}, ${person}, ${conversation}, 'on the conversation')`;
    await sql`insert into notes (organization_id, person_id, body) values (${o.org}, ${person}, 'on the person')`;
    await sql`insert into tasks (organization_id, person_id, conversation_id, name) values (${o.org}, ${person}, ${conversation}, 'call')`;
    await sql`insert into contact_policies (organization_id, person_id, do_not_contact, reason, source, set_at) values (${o.org}, ${person}, true, 'asked', 'human', now())`;
    await sql`
      insert into identity_exceptions (organization_id, channel, account_ref, source_event_key, reason, status, resolved_person_id, resolved_at)
      values (${o.org}, 'email', ${mailbox}, ${`ev-${t}`}, 'unknown sender', 'resolved', ${person}, now())`;
    let secondThread: string | null = null;
    if (opts.secondConversation) {
      // A second conversation with its own thread, event, note and task.
      const account = `li-${t}`;
      const secondConversation = await one(sql`insert into conversations (organization_id, person_id, reply_type_set_id) values (${o.org}, ${person}, ${o.typeSet2}) returning id`);
      secondThread = await one(sql`
        insert into threads (organization_id, conversation_id, channel, account_ref) values (${o.org}, ${secondConversation}, 'linkedin', ${account}) returning id`);
      await sql`
        insert into messages (organization_id, thread_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
        values (${o.org}, ${secondThread}, 'linkedin', ${account}, 'inbound', ${`li-in-${t}`}, 'second hello', now())`;
      await sql`insert into events (organization_id, person_id, conversation_id, event_type, actor_type) values (${o.org}, ${person}, ${secondConversation}, 'reply_type.changed', 'system')`;
      await sql`insert into notes (organization_id, person_id, conversation_id, body) values (${o.org}, ${person}, ${secondConversation}, 'second note')`;
      await sql`insert into tasks (organization_id, person_id, conversation_id, name) values (${o.org}, ${person}, ${secondConversation}, 'second task')`;
    }
    return { person, conversation, thread, inbound, outbound, classification, draft, secondThread, email: `${t}@lead.test` };
  }

  /** Rows that point at `person`, per table this context owns, plus the person's identity exceptions and ccs. */
  async function rowsOf(o: Org, p: { person: string }) {
    const recs = sql`(select id from conversations where person_id = ${p.person})`;
    const convs = sql`(select id from threads where conversation_id in ${recs})`;
    const [row] = await sql`
      select
        (select count(*) from conversations where person_id = ${p.person})::int as threads,
        (select count(*) from threads where id in ${convs})::int as threads,
        (select count(*) from messages where thread_id in ${convs})::int as messages,
        (select count(*) from reply_type_picks where conversation_id in ${recs})::int as classifications,
        (select count(*) from drafts where conversation_id in ${recs})::int as drafts,
        (select count(*) from send_attempts sa join drafts d on d.id = sa.draft_id where d.conversation_id in ${recs})::int as send_attempts,
        (select count(*) from follow_up_runs where conversation_id in ${recs})::int as follow_up_runs,
        (select count(*) from events where person_id = ${p.person} or conversation_id in ${recs})::int as events,
        (select count(*) from contact_policies where person_id = ${p.person})::int as policies,
        (select count(*) from notes where person_id = ${p.person})::int as notes,
        (select count(*) from tasks where person_id = ${p.person})::int as tasks,
        (select count(*) from ai_jobs where organization_id = ${o.org} and entity_id in (
          select id from messages where thread_id in ${convs}
          union all select id from reply_type_picks where conversation_id in ${recs}))::int as ai_jobs`;
    return row as Record<string, number>;
  }

  const allTables = async (org: string) =>
    (
      await sql`
        select
          (select count(*) from conversations where organization_id = ${org})::int as threads,
          (select count(*) from threads where organization_id = ${org})::int as threads,
          (select count(*) from messages where organization_id = ${org})::int as messages,
          (select count(*) from events where organization_id = ${org})::int as events,
          (select count(*) from drafts where organization_id = ${org})::int as drafts,
          (select count(*) from reply_type_picks where organization_id = ${org})::int as classifications,
          (select count(*) from ai_jobs where organization_id = ${org})::int as ai_jobs,
          (select count(*) from notes where organization_id = ${org})::int as notes,
          (select count(*) from lead_ccs where organization_id = ${org})::int as lead_ccs`
    )[0] as Record<string, number>;

  it("deletes every row of the person in this context, touches no other person or organization, and turns the switch off", async () => {
    const o = await organization();
    const target = await contact(o, "target", { secondConversation: true });
    const neighbour = await contact(o, "neighbour");
    // A cc of the neighbour that the target's message carried goes with that message.
    await sql`insert into lead_ccs (organization_id, person_id, email, source_message_id) values (${o.org}, ${neighbour.person}, ${`cc-${o.tag}@lead.test`}, ${target.inbound})`;
    // A neighbour draft that replies to the target's message keeps its row with a null target. drafts_reply_target_ins_trg
    // refuses that target, so the test turns it off to write the row.
    const crossDraft = await sql.begin(async (tx) => {
      await tx`alter table drafts disable trigger drafts_reply_target_ins_trg`;
      const id = await one(tx`
        insert into drafts (organization_id, conversation_id, thread_id, reply_for_message_id, expected_context_version, channel)
        values (${o.org}, ${neighbour.conversation}, ${neighbour.thread}, ${target.inbound}, 0, 'email') returning id`);
      await tx`alter table drafts enable trigger drafts_reply_target_ins_trg`;
      return id;
    });
    const elsewhere = await organization();
    const stranger = await contact(elsewhere, "stranger");
    const neighbourBefore = await rowsOf(o, neighbour);
    const elsewhereBefore = await allTables(elsewhere.org);
    expect(Object.values(await rowsOf(o, target)).every((n) => n > 0)).toBe(true);

    const result = await db.transaction(async (tx) => {
      await handling.lockPersonForDelete(tx, o.org, target.person);
      const purged = await purge.purgePersonHandling(tx, o.org, target.person);
      expect(await purge.purgeSwitchIsOn(tx)).toBe(false);
      // People's step: the do not contact row, then the people row. Notes, tasks and ccs go with it; nothing of this context refuses it now.
      await tx.execute(dsql`delete from contact_policies where person_id = ${target.person}`);
      await tx.execute(dsql`delete from people where id = ${target.person}`);
      return purged;
    });

    expect(result).toEqual({ conversations: 2, threads: 2, messages: 3, events: 3 });
    expect(await rowsOf(o, target)).toEqual(Object.fromEntries(Object.keys(neighbourBefore).map((k) => [k, 0])));
    expect(await rowsOf(o, neighbour)).toEqual(neighbourBefore);
    expect((await sql`select reply_for_message_id from drafts where id = ${crossDraft}`)[0].reply_for_message_id).toBeNull();
    expect((await sql`select count(*)::int as n from lead_ccs where person_id = ${neighbour.person}`)[0].n).toBe(0);
    expect(await allTables(elsewhere.org)).toEqual(elsewhereBefore);
    expect((await sql`select count(*)::int as n from conversations where person_id = ${stranger.person}`)[0].n).toBe(1);
    // identity_exceptions_resolution_ck: the exception stays resolved, now with no person.
    const [exception] = await sql`select status, resolved_person_id from identity_exceptions where source_event_key = ${`ev-${o.tag}-target`}`;
    expect(exception).toEqual({ status: "resolved", resolved_person_id: null });
    // The switch was transaction-local and the next transaction cannot delete a message.
    await expect(sql`delete from messages where id = ${neighbour.inbound}`).rejects.toThrow(/append-only/);
  });

  it("keeps a running AI job with a live lease, and deletes one whose lease ran out", async () => {
    const o = await organization();
    const target = await contact(o, "jobs");
    await sql`delete from ai_jobs where organization_id = ${o.org}`;
    const [live] = await sql`
      insert into ai_jobs (organization_id, kind, status, entity_type, entity_id, idempotency_key, locked_at, locked_by, started_at)
      values (${o.org}, 'initial_draft', 'running', 'classification', ${target.classification}, ${`live-${o.tag}`}, now(), 'w1', now()) returning id`;
    const [stale] = await sql`
      insert into ai_jobs (organization_id, kind, status, entity_type, entity_id, idempotency_key, locked_at, locked_by, started_at)
      values (${o.org}, 'classification', 'running', 'message', ${target.inbound}, ${`stale-${o.tag}`}, now() - interval '6 minutes', 'w2', now() - interval '6 minutes') returning id`;

    expect(await db.transaction((tx) => handling.personHandlingBlockers(tx, o.org, target.person))).toEqual([{ reason: "ai_job_running" }]);
    await sql`update ai_jobs set locked_at = now() - interval '6 minutes', started_at = now() - interval '6 minutes' where id = ${live.id}`;
    expect(await db.transaction((tx) => handling.personHandlingBlockers(tx, o.org, target.person))).toEqual([]);
    await sql`update ai_jobs set locked_at = now(), started_at = now() where id = ${live.id}`;

    // Without the blocker check, the purge still leaves the live job and removes the stale one.
    await db.transaction((tx) => purge.purgePersonHandling(tx, o.org, target.person));
    const left = (await sql`select id from ai_jobs where organization_id = ${o.org}`).map((r) => r.id);
    expect(left).toEqual([live.id]);
    expect(left).not.toContain(stale.id);
  });

  it.each(["prepared", "sending", "delivery_uncertain"])("blocks on a reply send in flight: an attempt in %s", async (status) => {
    const o = await organization();
    const target = await contact(o, "sending");
    // The fixture draft already holds a sent attempt, and a draft takes one terminal attempt, so the attempt goes on a second draft.
    const draft = await one(sql`
      insert into drafts (organization_id, conversation_id, thread_id, reply_for_message_id, expected_context_version, channel)
      values (${o.org}, ${target.conversation}, ${target.thread}, ${target.inbound}, 0, 'email') returning id`);
    await sql`
      insert into send_attempts (organization_id, draft_id, idempotency_key, actor_user_id, status) values (${o.org}, ${draft}, ${`sa2-${o.tag}`}, ${o.actors.member.userId}, ${status})`;
    expect(await db.transaction((tx) => handling.personHandlingBlockers(tx, o.org, target.person))).toEqual([{ reason: "send_in_flight" }]);
  });

  it("counts every row the purge removes, and blocks nothing at rest", async () => {
    const o = await organization();
    const target = await contact(o, "counted", { secondConversation: true });
    expect(await db.transaction((tx) => handling.personHandlingCounts(tx, o.org, target.person))).toEqual({ threads: 2, messages: 3, events: 3, notes: 3, tasks: 2 });
    expect(await db.transaction((tx) => handling.personHandlingBlockers(tx, o.org, target.person))).toEqual([]);
  });

  it("reads the do-not-contact row under a lock, and a person without one is not marked", async () => {
    const reach = await import("@/contexts/people/infrastructure/reachability");
    const o = await organization();
    const marked = await contact(o, "marked");
    const bare = await one(sql`insert into people (organization_id, email) values (${o.org}, ${`bare-${o.tag}@lead.test`}) returning id`);
    expect(await db.transaction((tx) => reach.lockDoNotContactTx(tx, o.org, marked.person))).toEqual({ doNotContact: true });
    expect(await db.transaction((tx) => reach.lockDoNotContactTx(tx, o.org, bare))).toEqual({ doNotContact: false });
    const elsewhere = await organization();
    expect(await db.transaction((tx) => reach.lockDoNotContactTx(tx, elsewhere.org, marked.person))).toEqual({ doNotContact: false });
  });

  it("holds the conversations, the conversations and the person lock until the delete commits, so no reply lands in between", async () => {
    const o = await organization();
    const target = await contact(o, "locks");
    const other = postgres(TEST_DATABASE_URL ?? "", { max: 1, onnotice: () => undefined });
    try {
      await db.transaction(async (tx) => {
        await handling.lockPersonForDelete(tx, o.org, target.person);
        // A message insert takes FOR KEY SHARE on its conversation, which the delete holds FOR UPDATE.
        await expect(
          other.begin(async (t) => {
            await t`set local lock_timeout = '200ms'`;
            await t`
              insert into messages (organization_id, thread_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
              values (${o.org}, ${target.thread}, 'email', ${`me-${o.tag}-locks@x.test`}, 'inbound', ${`race-${o.tag}`}, 'late reply', now())`;
          }),
        ).rejects.toMatchObject({ code: "55P03" });
        await expect(
          other.begin(async (t) => {
            await t`set local lock_timeout = '200ms'`;
            await t`select id from conversations where id = ${target.conversation} for update`;
          }),
        ).rejects.toMatchObject({ code: "55P03" });
        const [{ held }] = await other`
          select not pg_try_advisory_lock(hashtextextended(${`person-outreach:${o.org}:${target.person}`}, 0)) as held`;
        expect(held).toBe(true);
        const [{ timeout }] = (await tx.execute(dsql`select current_setting('lock_timeout') as timeout`)) as unknown as Array<{ timeout: string }>;
        expect(timeout).toBe("300ms");
      });
    } finally {
      await other.end();
    }
  });
});
