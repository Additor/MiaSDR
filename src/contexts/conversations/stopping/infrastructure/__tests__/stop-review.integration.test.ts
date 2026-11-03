import { afterAll, beforeAll, expect, it } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";

/**
 * The stop review rule has one reader-facing form, the views the baseline publishes, and two fragments the writer of
 * `stop_reviews` uses. Each way a reply can ask to stop must open the views and close them once a person reviews it, or
 * a person's review would leave a reply the agent send gate and enrollment still refuse.
 */
describeDb("the stop review rule", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 2 });
  let db: typeof import("@/platform/db/client").db;
  let review: typeof import("../stop-review");
  let requested: typeof import("../stop-requested-sql");
  let gate: typeof import("@/contexts/outreach/infrastructure/stop-review-gate");
  const orgs: TestOrg[] = [];

  beforeAll(async () => {
    db = (await import("@/platform/db/client")).db;
    review = await import("../stop-review");
    requested = await import("../stop-requested-sql");
    gate = await import("@/contexts/outreach/infrastructure/stop-review-gate");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  type Asks = "words" | "stored_flag" | "stop_type_pick" | "nothing";

  async function reply(asks: Asks) {
    const created = await createTestOrg(sql, "Review", "member");
    orgs.push(created);
    const { organizationId: org, userId: user, slug: tag } = created;
    const one = async (rows: PromiseLike<Array<{ id: string }>>) => (await rows)[0].id;
    const set = await one(sql`insert into reply_type_sets (organization_id, name, is_default) values (${org}, 'set', true) returning id`);
    const stopType = await one(sql`insert into reply_types (organization_id, reply_type_set_id, group_key, key, name, system_role, reply_draft, follow_ups) values (${org}, ${set}, 'not_interested', 'stop', 'Stop', 'stop_request', false, 'stop') returning id`);
    const person = await one(sql`insert into people (organization_id, email) values (${org}, ${`p-${tag}@lead.test`}) returning id`);
    const conversation = await one(sql`insert into conversations (organization_id, person_id, reply_type_set_id) values (${org}, ${person}, ${set}) returning id`);
    const thread = await one(sql`insert into threads (organization_id, conversation_id, channel, account_ref) values (${org}, ${conversation}, 'email', 'box@corp.test') returning id`);
    const raw = asks === "words" ? { stopAsked: true } : {};
    const message = await one(sql`
      insert into messages (organization_id, thread_id, channel, account_ref, direction, idempotency_key, body_text, sent_at, raw)
      values (${org}, ${thread}, 'email', 'box@corp.test', 'inbound', ${"m-" + tag}, 'Hello', now(), ${sql.json(raw as never)}) returning id`);
    await sql`update conversations set latest_inbound_message_id = ${message} where id = ${conversation}`;
    if (asks === "stored_flag" || asks === "stop_type_pick") {
      const response = asks === "stored_flag" ? { stopRequested: true } : {};
      const proposed = asks === "stop_type_pick" ? stopType : null;
      await sql`
        insert into reply_type_picks (organization_id, conversation_id, message_id, expected_context_version, proposed_group_key, proposed_reply_type_id, confidence, status, provider, rules, response)
        values (${org}, ${conversation}, ${message}, 0, 'not_interested', ${proposed}, 0.8, 'proposed', 'fake', ${sql.json({ replyDraft: false, followUps: "stop" } as never)}, ${sql.json(response as never)})`;
    }
    return { org, user, person, conversation, message };
  }
  type Reply = Awaited<ReturnType<typeof reply>>;

  const open = async (r: Reply) => {
    const forMessage = await requested.stopReviewOpen(db, r.message);
    const [{ forPerson }] = await sql`select exists (select 1 from stop_review_open_people v where v.person_id = ${r.person} and v.organization_id = ${r.org}) as "forPerson"`;
    const gated = await db.execute(drizzleSql`select 1 from people where people.id = ${r.person} and ${gate.personStopReviewOpenSql("people")}`);
    expect(forPerson).toBe(forMessage);
    expect([...gated].length > 0).toBe(forMessage);
    return forMessage;
  };

  it.each(["words", "stored_flag", "stop_type_pick"] as const)("a reply that asks through %s opens the review, and a person's review closes it", async (asks) => {
    const r = await reply(asks);
    expect(await open(r)).toBe(true);
    await db.transaction((tx) => review.personReviewedStopsTx(tx, { organizationId: r.org, conversationId: r.conversation, actorUserId: r.user, now: new Date() }));
    expect(await open(r)).toBe(false);
  });

  it("an agent's call closes nothing", async () => {
    const r = await reply("words");
    await db.transaction((tx) => review.personReviewedStopsTx(tx, { organizationId: r.org, conversationId: r.conversation, actorUserId: r.user, via: { tokenId: "t", tokenName: "n" } as never, now: new Date() }));
    expect(await open(r)).toBe(true);
  });

  it("a reply that asks nothing stays closed", async () => {
    expect(await open(await reply("nothing"))).toBe(false);
  });
});
