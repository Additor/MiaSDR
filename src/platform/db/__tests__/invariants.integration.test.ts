import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, type TestOrg } from "../../../test-support/db";

/**
 * Runs against a migrated Postgres. Set TEST_DATABASE_URL to enable:
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/t pnpm test
 */
describeDb("database invariants", () => {
  const sql = testSql();
  const orgs: TestOrg[] = [];
  const users: string[] = [];
  let orgA = "";
  let orgB = "";
  let personA = "";
  let campaignA = "";
  let enrollmentA = "";

  beforeAll(async () => {
    orgs.push(await createTestOrg(sql, "A"), await createTestOrg(sql, "B"));
    [orgA, orgB] = orgs.map((o) => o.organizationId);
    [{ id: personA }] = await sql`
      insert into people (organization_id, email) values (${orgA}, 'Lead@Example.com') returning id`;
    [{ id: campaignA }] = await sql`
      insert into campaigns (organization_id, channel, name) values (${orgA}, 'email', 'c') returning id`;
    [{ id: enrollmentA }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel)
      values (${orgA}, ${campaignA}, ${personA}, 'email') returning id`;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs, users);
    await sql.end();
  });

  it("rejects an enrollment that points at another tenant's person", async () => {
    const [{ id: campaignB }] = await sql`
      insert into campaigns (organization_id, channel, name) values (${orgB}, 'email', 'cb') returning id`;
    await expect(
      sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel)
          values (${orgB}, ${campaignB}, ${personA}, 'email')`,
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("treats emails case-insensitively per organization, and allows the same email in another org", async () => {
    await expect(
      sql`insert into people (organization_id, email) values (${orgA}, 'lead@example.com')`,
    ).rejects.toThrow(/unique|duplicate/i);
    await expect(
      sql`insert into people (organization_id, email) values (${orgB}, 'lead@example.com')`,
    ).resolves.toBeDefined();
  });

  it("allows many people without an email", async () => {
    await sql`insert into people (organization_id, first_name) values (${orgA}, 'x'), (${orgA}, 'y')`;
  });

  it("lets only one caller claim a step", async () => {
    const claim = () =>
      sql`insert into sends (organization_id, enrollment_id, step_number, channel)
          values (${orgA}, ${enrollmentA}, 1, 'email')
          on conflict (enrollment_id, step_number) do nothing returning id`;
    const results = await Promise.all([claim(), claim(), claim()]);
    expect(results.filter((r) => r.length === 1)).toHaveLength(1);
  });

  it("enforces one enrollment per person per campaign", async () => {
    await expect(
      sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel)
          values (${orgA}, ${campaignA}, ${personA}, 'email')`,
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("requires exactly one sender in campaign_senders", async () => {
    await expect(
      sql`insert into campaign_senders (organization_id, campaign_id) values (${orgA}, ${campaignA})`,
    ).rejects.toThrow(/check/i);
  });

  describe("grid_user_views", () => {
    let tableA = "";
    let user1 = "";
    let user2 = "";

    beforeAll(async () => {
      const suffix = uniqueKey();
      [{ id: user1 }] = await sql`insert into users (name, email) values ('u1', ${"u1-" + suffix + "@example.com"}) returning id`;
      [{ id: user2 }] = await sql`insert into users (name, email) values ('u2', ${"u2-" + suffix + "@example.com"}) returning id`;
      users.push(user1, user2);
      const [{ id: wb }] = await sql`insert into grid_workbooks (organization_id, name) values (${orgA}, 'wb') returning id`;
      [{ id: tableA }] = await sql`
        insert into grid_tables (organization_id, workbook_id, name, position) values (${orgA}, ${wb}, 't', 1) returning id`;
    });

    it("rejects a view whose organization differs from its table's", async () => {
      await expect(
        sql`insert into grid_user_views (organization_id, table_id, user_id) values (${orgB}, ${tableA}, ${user1})`,
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it("keeps one view row per user and table", async () => {
      await sql`insert into grid_user_views (organization_id, table_id, user_id, view) values (${orgA}, ${tableA}, ${user1}, '{"a":1}')`;
      await expect(
        sql`insert into grid_user_views (organization_id, table_id, user_id) values (${orgA}, ${tableA}, ${user1})`,
      ).rejects.toThrow(/unique|duplicate/i);
      await expect(
        sql`insert into grid_user_views (organization_id, table_id, user_id) values (${orgA}, ${tableA}, ${user2})`,
      ).resolves.toBeDefined();
    });
  });
});
