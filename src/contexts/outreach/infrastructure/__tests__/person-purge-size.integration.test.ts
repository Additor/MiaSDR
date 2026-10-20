import { sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";

/**
 * The size check of "Contacts and Companies CRUD" in docs/decisions.md. A contact with a long history: 10,000 messages
 * in 40 conversations, 2,000 campaign sends in 200 campaigns and 500 history lines, next to a second contact with a history
 * of its own. The delete's conversations and outreach purges run in one transaction under the 30 s statement timeout of
 * `deleteContact`, after its locks. A statement over the timeout fails the test; the test prints the time it took and
 * asserts no wall-clock bound, so a slow runner does not fail it.
 */
const CONVERSATIONS = 40;
const MESSAGES_PER_CONVERSATION = 250;
const CAMPAIGNS = 200;
const STEPS = 10;
const EVENTS = 500;
const STATEMENT_TIMEOUT = "30s";

describeDb("contact delete: purge size check", () => {
  useTestEnv();
  const sql = testSql({ max: 2 });
  let db: typeof import("@/platform/db/client").db;
  let handling: typeof import("@/contexts/conversations/infrastructure/person-handling");
  let purge: typeof import("@/contexts/conversations/infrastructure/person-purge");
  let outreach: typeof import("../person-outreach");
  const orgs: string[] = [];

  beforeAll(async () => {
    db = (await import("@/platform/db/client")).db;
    handling = await import("@/contexts/conversations/infrastructure/person-handling");
    purge = await import("@/contexts/conversations/infrastructure/person-purge");
    outreach = await import("../person-outreach");
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  const one = async (rows: PromiseLike<Array<{ id: string }>>) => (await rows)[0].id as string;

  /** A contact with `conversations` email threads of `perConversation` messages each, `campaigns` enrollments of `steps` sends, and `events` history lines. */
  async function seed(org: string, tag: string, label: string, size: { conversations: number; perConversation: number; campaigns: number; steps: number; events: number }) {
    const t = `${tag}-${label}`;
    const pipeline = await one(sql`select id from pipelines where organization_id = ${org} and is_default`);
    const person = await one(sql`
      insert into people (organization_id, email, full_name, lifecycle, converted_at) values (${org}, ${`${t}@lead.test`}, ${label}, 'contact', now()) returning id`);
    const record = await one(sql`insert into records (organization_id, person_id, pipeline_id) values (${org}, ${person}, ${pipeline}) returning id`);
    await sql`
      insert into conversations (organization_id, record_id, channel, account_ref)
      select ${org}, ${record}, 'email', ${`me-${t}-`} || g from generate_series(1, ${size.conversations}) g`;
    await sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      select ${org}, c.id, 'email', c.account_ref, case when g % 2 = 0 then 'inbound' else 'outbound' end,
             c.id::text || '-' || g, 'Message ' || g || ' about the proposal and the next call.', now() - make_interval(mins => g)
      from conversations c cross join generate_series(1, ${size.perConversation}) g
      where c.organization_id = ${org} and c.record_id = ${record}`;
    // The latest inbound message of the record, which the message delete sets to null through the 0027 index.
    await sql`
      update records set latest_inbound_message_id = (
        select m.id from messages m join conversations c on c.id = m.conversation_id
        where c.record_id = ${record} and m.direction = 'inbound' order by m.sent_at desc limit 1)
      where id = ${record}`;
    await sql`
      insert into events (organization_id, person_id, record_id, event_type, actor_type)
      select ${org}, ${person}, case when g % 2 = 0 then ${record}::uuid end, 'stage.moved', 'system' from generate_series(1, ${size.events}) g`;
    await sql`
      insert into notes (organization_id, person_id, record_id, body)
      select ${org}, ${person}, ${record}, 'Note ' || g from generate_series(1, 20) g`;
    await sql`
      insert into tasks (organization_id, person_id, name)
      select ${org}, ${person}, 'Task ' || g from generate_series(1, 20) g`;
    const mailbox = await one(sql`insert into mailboxes (organization_id, email_address, status) values (${org}, ${`box-${t}@x.test`}, 'connected') returning id`);
    await sql`
      insert into campaigns (organization_id, channel, name, status)
      select ${org}, 'email', ${`${label} campaign `} || g, 'completed' from generate_series(1, ${size.campaigns}) g`;
    await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step)
      select ${org}, c.id, ${person}, 'email', 'completed', ${size.steps}
      from campaigns c where c.organization_id = ${org} and c.name like ${`${label} campaign %`}`;
    await sql`
      insert into sends (organization_id, kind, enrollment_id, step_number, channel, status, mailbox_id, subject, body, claimed_at, sent_at)
      select ${org}, 'campaign', e.id, g, 'email', 'sent', ${mailbox}, 'Hello', 'A campaign email body.', now() - interval '30 days', now() - interval '30 days'
      from campaign_enrollments e cross join generate_series(1, ${size.steps}) g
      where e.organization_id = ${org} and e.person_id = ${person}`;
    return { person, record };
  }

  async function countsOf(org: string, person: string) {
    const [row] = await sql`
      select
        (select count(*)::int from messages m join conversations c on c.id = m.conversation_id join records r on r.id = c.record_id where r.person_id = ${person}) as messages,
        (select count(*)::int from conversations c join records r on r.id = c.record_id where r.person_id = ${person}) as conversations,
        (select count(*)::int from events where organization_id = ${org} and person_id = ${person}) as events,
        (select count(*)::int from sends s join campaign_enrollments e on e.id = s.enrollment_id where e.person_id = ${person}) as sends,
        (select count(*)::int from campaign_enrollments where person_id = ${person}) as enrollments,
        (select count(*)::int from notes where person_id = ${person}) as notes,
        (select count(*)::int from people where id = ${person}) as people`;
    return row;
  }

  it(
    "purges a contact with 10,000 messages, 2,000 sends and 500 events inside the statement timeout",
    async () => {
      const tag = uniqueKey();
      const org = await one(sql`insert into organizations (name, slug) values ('Purge size', ${"purge-size-" + tag}) returning id`);
      orgs.push(org);
      await sql`insert into pipelines (organization_id, name, is_default) values (${org}, 'p', true)`;
      const size = { conversations: CONVERSATIONS, perConversation: MESSAGES_PER_CONVERSATION, campaigns: CAMPAIGNS, steps: STEPS, events: EVENTS };
      const target = await seed(org, tag, "target", size);
      const bystander = await seed(org, tag, "bystander", { ...size, conversations: 10, campaigns: 20 });
      await sql`analyze`;

      expect(await countsOf(org, target.person)).toEqual({ messages: 10_000, conversations: 40, events: 500, sends: 2_000, enrollments: 200, notes: 20, people: 1 });
      const bystanderBefore = await countsOf(org, bystander.person);

      const started = performance.now();
      const result = await db.transaction(async (tx) => {
        await tx.execute(dsql.raw(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`));
        await tx.execute(dsql.raw(`set local lock_timeout = '5s'`));
        await handling.lockPersonForDelete(tx, org, target.person);
        await tx.execute(dsql`select id from people where id = ${target.person}::uuid for update`);
        await handling.lockContactPolicy(tx, org, target.person);
        const conversations = await purge.purgePersonHandling(tx, org, target.person);
        const enrollments = await outreach.purgePersonOutreach(tx, org, target.person);
        await tx.execute(dsql`delete from people where organization_id = ${org} and id = ${target.person}::uuid`);
        return { conversations, enrollments };
      });
      const elapsed = performance.now() - started;
      console.info(
        `purge size check: ${result.conversations.messages} messages in ${result.conversations.conversations} conversations, ` +
          `${result.enrollments.sends} sends in ${result.enrollments.enrollments} enrollments, ${result.conversations.events} events: ${Math.round(elapsed)} ms`,
      );

      expect(result).toEqual({
        conversations: { records: 1, conversations: 40, messages: 10_000, events: 500 },
        enrollments: { enrollments: 200, sends: 2_000 },
      });
      expect(await countsOf(org, target.person)).toEqual({ messages: 0, conversations: 0, events: 0, sends: 0, enrollments: 0, notes: 0, people: 0 });
      expect(await countsOf(org, bystander.person)).toEqual(bystanderBefore);
    },
    180_000,
  );
});
