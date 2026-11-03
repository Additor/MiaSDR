import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, type TestOrg } from "../../../test-support/db";

/** The CHECKs and the key that hold the system reply types. Needs TEST_DATABASE_URL. */
describeDb("reply type rules", () => {
  const sql = testSql();
  let org: TestOrg;
  let set: string;
  let stop: string;
  let plain: string;

  const addType = async (key: string, group: string, role: string | null, rules: { draft?: boolean; followUps?: string } = {}) => {
    const [{ id }] = await sql<{ id: string }[]>`
      insert into reply_types (organization_id, reply_type_set_id, group_key, key, name, reply_draft, follow_ups, system_role)
      values (${org.organizationId}, ${set}, ${group}, ${key}, ${key}, ${rules.draft ?? false}, ${rules.followUps ?? "stop"}, ${role})
      returning id`;
    return id;
  };

  beforeAll(async () => {
    org = await createTestOrg(sql);
    [{ id: set }] = await sql<{ id: string }[]>`insert into reply_type_sets (organization_id, name, is_default) values (${org.organizationId}, 'Default', true) returning id`;
    stop = await addType("do_not_contact", "not_interested", "stop_request");
    plain = await addType("pricing", "interested", null);
  });
  afterAll(async () => {
    await dropOrgs(sql, [org]);
    await sql.end();
  });

  it("keeps the rules of the stop request type", async () => {
    await expect(sql`update reply_types set reply_draft = true where id = ${stop}`).rejects.toThrow(/reply_types_stop_request_ck/);
    await expect(sql`update reply_types set follow_ups = 'continue' where id = ${stop}`).rejects.toThrow(/reply_types_stop_request_ck/);
  });

  it("holds one type per role in a set, and the customer type in its group", async () => {
    await expect(addType("stop_two", "not_interested", "stop_request")).rejects.toThrow(/reply_types_set_system_role_uq/);
    await expect(addType("vip", "interested", "customer")).rejects.toThrow(/reply_types_customer_ck/);
    const customer = await addType("customer", "customer", "customer");
    await sql`update reply_types set name = 'VIP' where id = ${customer}`;
  });

  it("refuses a follow-ups rule outside the list", async () => {
    await expect(sql`update reply_types set follow_ups = 'sometimes' where id = ${plain}`).rejects.toThrow(/reply_types_rules_ck/);
  });

  it("removes an organization's agent usage with the organization", async () => {
    const other = await createTestOrg(sql);
    await sql`insert into mcp_agent_usage (organization_id, day, kind, amount) values (${other.organizationId}, '2026-11-02', 'irreversible', 1)`;
    await dropOrgs(sql, [other]);
    expect(await sql`select 1 from mcp_agent_usage where organization_id = ${other.organizationId}`).toHaveLength(0);
  });
});
