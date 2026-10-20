import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, type TestOrg } from "../../../test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. See invariants.integration.test.ts. */
describeDb("conversation invariants", () => {
  const sql = testSql();
  let owner: TestOrg;
  let org = "";
  let user = "";
  let person = "";
  let pipeline = "";
  let otherPipeline = "";
  let sub = "";
  let record = "";
  let conversation = "";
  let draft = "";

  beforeAll(async () => {
    const s = uniqueKey();
    owner = await createTestOrg(sql, "C");
    ({ organizationId: org, userId: user } = owner);
    [{ id: person }] = await sql`insert into people (organization_id, email) values (${org}, ${s + "@lead.test"}) returning id`;
    [{ id: pipeline }] = await sql`insert into pipelines (organization_id, name, is_default) values (${org}, 'p1', true) returning id`;
    [{ id: otherPipeline }] = await sql`insert into pipelines (organization_id, name) values (${org}, 'p2') returning id`;
    [{ id: sub }] = await sql`
      insert into subcategories (organization_id, pipeline_id, category_key, key, name)
      values (${org}, ${pipeline}, 'interested', 'wants_demo', 'Wants demo') returning id`;
    [{ id: record }] = await sql`
      insert into records (organization_id, person_id, pipeline_id) values (${org}, ${person}, ${pipeline}) returning id`;
    [{ id: conversation }] = await sql`
      insert into conversations (organization_id, record_id, channel, account_ref)
      values (${org}, ${record}, 'email', 'me@corp.test') returning id`;
    [{ id: draft }] = await sql`
      insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, subject)
      values (${org}, ${record}, ${conversation}, 0, 'email', 'Re: hi') returning id`;
  });

  afterAll(async () => {
    await dropOrgs(sql, [owner]);
    await sql.end();
  });

  it("rejects a subcategory from a different pipeline than the record's", async () => {
    const [{ id: other }] = await sql`
      insert into records (organization_id, person_id, pipeline_id)
      select ${org}, id, ${otherPipeline} from people where id = ${person} returning id`;
    await expect(
      sql`update records set subcategory_id = ${sub}, category_key = 'interested', category_source = 'ai' where id = ${other}`,
    ).rejects.toThrow(/foreign key|violates/i);
    await sql`delete from records where id = ${other}`;
  });

  it("accepts the same subcategory on a record in its own pipeline", async () => {
    await sql`update records set subcategory_id = ${sub}, category_key = 'interested', category_source = 'ai' where id = ${record}`;
  });

  it("requires category and source to be set together", async () => {
    await expect(
      sql`insert into records (organization_id, person_id, pipeline_id, category_key)
          values (${org}, ${person}, ${otherPipeline}, 'other')`,
    ).rejects.toThrow(/check/i);
  });

  it("allows only the three do-not-contact shapes", async () => {
    await expect(
      sql`insert into contact_policies (person_id, organization_id, do_not_contact) values (${person}, ${org}, true)`,
    ).rejects.toThrow(/check/i);
    await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at)
              values (${person}, ${org}, true, 'human', now())`;
    await expect(
      sql`update contact_policies set do_not_contact = false, cleared_at = set_at - interval '1 day' where person_id = ${person}`,
    ).rejects.toThrow(/check/i);
    await sql`update contact_policies set do_not_contact = false, cleared_at = now() where person_id = ${person}`;
  });

  it("allows one terminal send attempt per draft", async () => {
    const attempt = (key: string, status: string) =>
      sql`insert into send_attempts (organization_id, draft_id, idempotency_key, status, actor_user_id)
          values (${org}, ${draft}, ${key}, ${status}, ${user})`;
    await attempt("k1", "failed");
    await attempt("k2", "failed");
    await attempt("k3", "sent");
    await expect(attempt("k4", "delivery_uncertain")).rejects.toThrow(/unique|duplicate/i);
  });

  it("requires a real user on human audit events", async () => {
    await expect(
      sql`insert into events (organization_id, person_id, event_type, actor_type)
          values (${org}, ${person}, 'category_changed', 'human')`,
    ).rejects.toThrow(/check/i);
    await sql`insert into events (organization_id, person_id, event_type, actor_type, actor_user_id)
              values (${org}, ${person}, 'category_changed', 'human', ${user})`;
  });

  it("keeps a message consistent with its conversation's channel and account", async () => {
    await expect(
      sql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
          values (${org}, ${conversation}, 'linkedin', 'me@corp.test', 'inbound', 'm1', 'hi', now())`,
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("makes a message idempotent per channel and account", async () => {
    const insert = () =>
      sql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
          values (${org}, ${conversation}, 'email', 'me@corp.test', 'inbound', 'same', 'hi', now())`;
    await insert();
    await expect(insert()).rejects.toThrow(/unique|duplicate/i);
  });
});
