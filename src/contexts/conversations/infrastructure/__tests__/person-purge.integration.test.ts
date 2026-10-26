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
    const pipeline = await one(sql`insert into pipelines (organization_id, name, is_default) values (${org}, 'p', true) returning id`);
    // A person has one record per pipeline, so the private record of `contact` lives in a second pipeline.
    const pipeline2 = await one(sql`insert into pipelines (organization_id, name, is_default) values (${org}, 'p2', false) returning id`);
    const sub = await one(sql`insert into subcategories (organization_id, pipeline_id, category_key, key, name) values (${org}, ${pipeline}, 'interested', 'a', 'A') returning id`);
    const personal = await one(sql`insert into campaigns (organization_id, channel, name, type, created_by) values (${org}, 'linkedin', 'Mine', 'personal', ${other}) returning id`);
    const actors = {
      member: { userId: member, organizationId: org, role: "member" } satisfies Actor,
      other: { userId: other, organizationId: org, role: "member" } satisfies Actor,
      admin: { userId: admin, organizationId: org, role: "admin" } satisfies Actor,
    };
    return { org, tag, pipeline, pipeline2, sub, personal, actors };
  }
  type Org = Awaited<ReturnType<typeof organization>>;

  /**
   * A contact with a row in every table the purge touches: one record with a public email thread (two messages, a
   * classification, AI jobs, a draft with a send attempt, a follow-up run with a step run, a follow-up choice), events on
   * the person and on the record, notes and tasks on both, a do-not-contact row and a resolved identity exception. On
   * request, a second record whose only thread is private, in another member's personal campaign.
   */
  async function contact(o: Org, label: string, opts: { privateThread?: boolean } = {}) {
    const t = `${o.tag}-${label}`;
    const person = await one(sql`
      insert into people (organization_id, email, full_name, lifecycle, converted_at) values (${o.org}, ${`${t}@lead.test`}, ${label}, 'contact', now()) returning id`);
    const record = await one(sql`insert into records (organization_id, person_id, pipeline_id) values (${o.org}, ${person}, ${o.pipeline}) returning id`);
    const mailbox = `me-${t}@x.test`;
    const conversation = await one(sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${o.org}, ${record}, 'email', ${mailbox}) returning id`);
    const inbound = await one(sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${o.org}, ${conversation}, 'email', ${mailbox}, 'inbound', ${`in-${t}`}, 'hello', now()) returning id`);
    const outbound = await one(sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${o.org}, ${conversation}, 'email', ${mailbox}, 'outbound', ${`out-${t}`}, 'reply', now()) returning id`);
    await sql`update records set latest_inbound_message_id = ${inbound} where id = ${record}`;
    const classification = await one(sql`
      insert into classifications (organization_id, record_id, message_id, expected_context_version, previous_subcategory_id, proposed_subcategory_id, applied_subcategory_id, confidence)
      values (${o.org}, ${record}, ${inbound}, 0, ${o.sub}, ${o.sub}, ${o.sub}, 0.9) returning id`);
    await sql`insert into ai_jobs (organization_id, kind, status, entity_type, entity_id, idempotency_key, completed_at) values (${o.org}, 'classification', 'succeeded', 'message', ${inbound}, ${`job-c-${t}`}, now())`;
    await sql`insert into ai_jobs (organization_id, kind, status, entity_type, entity_id, idempotency_key) values (${o.org}, 'initial_draft', 'queued', 'classification', ${classification}, ${`job-d-${t}`})`;
    const draft = await one(sql`
      insert into drafts (organization_id, record_id, conversation_id, reply_for_message_id, expected_context_version, channel)
      values (${o.org}, ${record}, ${conversation}, ${inbound}, 0, 'email') returning id`);
    const attempt = await one(sql`
      insert into send_attempts (organization_id, draft_id, idempotency_key, actor_user_id, status) values (${o.org}, ${draft}, ${`sa-${t}`}, ${o.actors.member.userId}, 'prepared') returning id`);
    await sql`update send_attempts set status = 'sent' where id = ${attempt}`;
    const sequence = await one(sql`insert into sequences (organization_id, name) values (${o.org}, ${`Seq ${t}`}) returning id`);
    const version = await one(sql`insert into sequence_versions (organization_id, sequence_id, version) values (${o.org}, ${sequence}, 1) returning id`);
    const step = await one(sql`
      insert into sequence_steps (organization_id, sequence_version_id, position, step_type, name, delay_minutes, ai_instructions)
      values (${o.org}, ${version}, 1, 'reply', 'Step 1', 0, 'Write a short note.') returning id`);
    await sql`update sequence_versions set status = 'published', published_at = now() where id = ${version}`;
    const run = await one(sql`
      insert into sequence_runs (organization_id, record_id, conversation_id, sequence_id, sequence_version_id, subcategory_id, status, started_by, trigger_message_id, last_inbound_at_start)
      values (${o.org}, ${record}, ${conversation}, ${sequence}, ${version}, ${o.sub}, 'completed', 'ai_assignment', ${inbound}, now()) returning id`);
    await sql`
      insert into sequence_step_runs (organization_id, sequence_run_id, sequence_step_id, status, due_at, draft_id, sent_message_id, expected_context_version)
      values (${o.org}, ${run}, ${step}, 'sent', now(), ${draft}, ${outbound}, 0)`;
    await sql`insert into events (organization_id, person_id, record_id, event_type, actor_type) values (${o.org}, ${person}, ${record}, 'stage.moved', 'system')`;
    await sql`insert into events (organization_id, person_id, event_type, actor_type) values (${o.org}, ${person}, 'lifecycle.converted', 'system')`;
    await sql`insert into notes (organization_id, person_id, record_id, body) values (${o.org}, ${person}, ${record}, 'on the record')`;
    await sql`insert into notes (organization_id, person_id, body) values (${o.org}, ${person}, 'on the person')`;
    await sql`insert into tasks (organization_id, person_id, record_id, name) values (${o.org}, ${person}, ${record}, 'call')`;
    await sql`insert into contact_policies (organization_id, person_id, do_not_contact, reason, source, set_at) values (${o.org}, ${person}, true, 'asked', 'human', now())`;
    await sql`
      insert into identity_exceptions (organization_id, channel, account_ref, source_event_key, reason, status, resolved_person_id, resolved_at)
      values (${o.org}, 'email', ${mailbox}, ${`ev-${t}`}, 'unknown sender', 'resolved', ${person}, now())`;
    let privateConversation: string | null = null;
    if (opts.privateThread) {
      // A second record whose only thread is private, with an event, a note and a task of its own.
      const account = `li-${t}`;
      const privateRecord = await one(sql`insert into records (organization_id, person_id, pipeline_id) values (${o.org}, ${person}, ${o.pipeline2}) returning id`);
      privateConversation = await one(sql`
        insert into conversations (organization_id, record_id, channel, account_ref, private_campaign_id) values (${o.org}, ${privateRecord}, 'linkedin', ${account}, ${o.personal}) returning id`);
      await sql`
        insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
        values (${o.org}, ${privateConversation}, 'linkedin', ${account}, 'inbound', ${`li-in-${t}`}, 'private hello', now())`;
      await sql`insert into events (organization_id, person_id, record_id, event_type, actor_type) values (${o.org}, ${person}, ${privateRecord}, 'stage.moved', 'system')`;
      await sql`insert into notes (organization_id, person_id, record_id, body) values (${o.org}, ${person}, ${privateRecord}, 'private note')`;
      await sql`insert into tasks (organization_id, person_id, record_id, name) values (${o.org}, ${person}, ${privateRecord}, 'private task')`;
    }
    return { person, record, conversation, inbound, outbound, classification, draft, privateConversation, email: `${t}@lead.test` };
  }

  /** Rows that point at `person`, per table this context owns, plus the person's identity exceptions and ccs. */
  async function rowsOf(o: Org, p: { person: string }) {
    const recs = sql`(select id from records where person_id = ${p.person})`;
    const convs = sql`(select id from conversations where record_id in ${recs})`;
    const [row] = await sql`
      select
        (select count(*) from records where person_id = ${p.person})::int as records,
        (select count(*) from conversations where id in ${convs})::int as conversations,
        (select count(*) from messages where conversation_id in ${convs})::int as messages,
        (select count(*) from classifications where record_id in ${recs})::int as classifications,
        (select count(*) from drafts where record_id in ${recs})::int as drafts,
        (select count(*) from send_attempts sa join drafts d on d.id = sa.draft_id where d.record_id in ${recs})::int as send_attempts,
        (select count(*) from sequence_runs where record_id in ${recs})::int as sequence_runs,
        (select count(*) from events where person_id = ${p.person} or record_id in ${recs})::int as events,
        (select count(*) from contact_policies where person_id = ${p.person})::int as policies,
        (select count(*) from notes where person_id = ${p.person})::int as notes,
        (select count(*) from tasks where person_id = ${p.person})::int as tasks,
        (select count(*) from ai_jobs where organization_id = ${o.org} and entity_id in (
          select id from messages where conversation_id in ${convs}
          union all select id from classifications where record_id in ${recs}))::int as ai_jobs`;
    return row as Record<string, number>;
  }

  const allTables = async (org: string) =>
    (
      await sql`
        select
          (select count(*) from records where organization_id = ${org})::int as records,
          (select count(*) from conversations where organization_id = ${org})::int as conversations,
          (select count(*) from messages where organization_id = ${org})::int as messages,
          (select count(*) from events where organization_id = ${org})::int as events,
          (select count(*) from drafts where organization_id = ${org})::int as drafts,
          (select count(*) from classifications where organization_id = ${org})::int as classifications,
          (select count(*) from ai_jobs where organization_id = ${org})::int as ai_jobs,
          (select count(*) from notes where organization_id = ${org})::int as notes,
          (select count(*) from lead_ccs where organization_id = ${org})::int as lead_ccs`
    )[0] as Record<string, number>;

  it("deletes every row of the person in this context, touches no other person or organization, and turns the switch off", async () => {
    const o = await organization();
    const target = await contact(o, "target", { privateThread: true });
    const neighbour = await contact(o, "neighbour");
    // A cc of the neighbour that the target's message carried goes with that message.
    await sql`insert into lead_ccs (organization_id, person_id, email, source_message_id) values (${o.org}, ${neighbour.person}, ${`cc-${o.tag}@lead.test`}, ${target.inbound})`;
    // A neighbour draft that replies to the target's message keeps its row with a null target.
    const crossDraft = await one(sql`
      insert into drafts (organization_id, record_id, conversation_id, reply_for_message_id, expected_context_version, channel)
      values (${o.org}, ${neighbour.record}, ${neighbour.conversation}, ${target.inbound}, 0, 'email') returning id`);
    const elsewhere = await organization();
    const stranger = await contact(elsewhere, "stranger");
    const neighbourBefore = await rowsOf(o, neighbour);
    const elsewhereBefore = await allTables(elsewhere.org);
    expect(Object.values(await rowsOf(o, target)).every((n) => n > 0)).toBe(true);

    const result = await db.transaction(async (tx) => {
      await handling.lockPersonForDelete(tx, o.org, target.person);
      const purged = await purge.purgePersonHandling(tx, o.org, target.person);
      expect(await purge.purgeSwitchIsOn(tx)).toBe(false);
      // Notes, tasks and ccs of the person go with the people row; nothing of this context refuses it now.
      await tx.execute(dsql`delete from people where id = ${target.person}`);
      return purged;
    });

    expect(result).toEqual({ records: 2, conversations: 2, messages: 3, events: 3 });
    expect(await rowsOf(o, target)).toEqual(Object.fromEntries(Object.keys(neighbourBefore).map((k) => [k, 0])));
    expect(await rowsOf(o, neighbour)).toEqual(neighbourBefore);
    expect((await sql`select reply_for_message_id from drafts where id = ${crossDraft}`)[0].reply_for_message_id).toBeNull();
    expect((await sql`select count(*)::int as n from lead_ccs where person_id = ${neighbour.person}`)[0].n).toBe(0);
    expect(await allTables(elsewhere.org)).toEqual(elsewhereBefore);
    expect((await sql`select count(*)::int as n from records where person_id = ${stranger.person}`)[0].n).toBe(1);
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

    expect(await db.transaction((tx) => handling.personHandlingBlockers(tx, o.actors.admin, target.person))).toEqual([{ reason: "ai_job_running" }]);
    await sql`update ai_jobs set locked_at = now() - interval '6 minutes', started_at = now() - interval '6 minutes' where id = ${live.id}`;
    expect(await db.transaction((tx) => handling.personHandlingBlockers(tx, o.actors.admin, target.person))).toEqual([]);
    await sql`update ai_jobs set locked_at = now(), started_at = now() where id = ${live.id}`;

    // Without the blocker check, the purge still leaves the live job and removes the stale one.
    await db.transaction((tx) => purge.purgePersonHandling(tx, o.org, target.person));
    const left = (await sql`select id from ai_jobs where organization_id = ${o.org}`).map((r) => r.id);
    expect(left).toEqual([live.id]);
    expect(left).not.toContain(stale.id);
  });

  it("blocks on a reply send in flight", async () => {
    const o = await organization();
    const target = await contact(o, "sending");
    await sql`
      insert into send_attempts (organization_id, draft_id, idempotency_key, actor_user_id, status) values (${o.org}, ${target.draft}, ${`sa2-${o.tag}`}, ${o.actors.member.userId}, 'prepared')`;
    expect(await db.transaction((tx) => handling.personHandlingBlockers(tx, o.actors.admin, target.person))).toEqual([{ reason: "send_in_flight" }]);
  });

  it("counts what the actor sees: a member misses another member's private thread and is blocked, the creator and an admin are not", async () => {
    const o = await organization();
    const target = await contact(o, "private", { privateThread: true });
    const counts = (actor: Actor) => db.transaction((tx) => handling.personHandlingCounts(tx, actor, target.person));
    const blockers = (actor: Actor) => db.transaction((tx) => handling.personHandlingBlockers(tx, actor, target.person));

    expect(await counts(o.actors.admin)).toEqual({ conversations: 2, messages: 3, events: 3, notes: 3, tasks: 2, hidden: false });
    expect(await counts(o.actors.other)).toEqual({ conversations: 2, messages: 3, events: 3, notes: 3, tasks: 2, hidden: false });
    // The private record's event, note and task leave the member's counts with its thread.
    expect(await counts(o.actors.member)).toEqual({ conversations: 1, messages: 2, events: 2, notes: 2, tasks: 1, hidden: true });
    expect(await blockers(o.actors.member)).toEqual([{ reason: "private_conversation" }]);
    expect(await blockers(o.actors.other)).toEqual([]);
    expect(await blockers(o.actors.admin)).toEqual([]);
  });

  it("reads the do-not-contact row under a lock, and a person without one is not marked", async () => {
    const o = await organization();
    const marked = await contact(o, "marked");
    const bare = await one(sql`insert into people (organization_id, email) values (${o.org}, ${`bare-${o.tag}@lead.test`}) returning id`);
    expect(await db.transaction((tx) => handling.lockContactPolicy(tx, o.org, marked.person))).toEqual({ doNotContact: true });
    expect(await db.transaction((tx) => handling.lockContactPolicy(tx, o.org, bare))).toEqual({ doNotContact: false });
    const elsewhere = await organization();
    expect(await db.transaction((tx) => handling.lockContactPolicy(tx, elsewhere.org, marked.person))).toEqual({ doNotContact: false });
  });

  it("holds the records, the conversations and the person lock until the delete commits, so no reply lands in between", async () => {
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
              insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
              values (${o.org}, ${target.conversation}, 'email', ${`me-${o.tag}-locks@x.test`}, 'inbound', ${`race-${o.tag}`}, 'late reply', now())`;
          }),
        ).rejects.toMatchObject({ code: "55P03" });
        await expect(
          other.begin(async (t) => {
            await t`set local lock_timeout = '200ms'`;
            await t`select id from records where id = ${target.record} for update`;
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
