import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, insertFollowUpFlow, testSql, type TestOrg } from "../../../test-support/db";

/** Constraint checks for the follow-up and grid tables. Set TEST_DATABASE_URL to enable. */
describeDb("follow-up and grid invariants", () => {
  const sql = testSql();
  const orgs: TestOrg[] = [];
  let orgA = "";
  let orgB = "";
  let tableA = "";
  let rowA = "";

  beforeAll(async () => {
    orgs.push(await createTestOrg(sql, "A"), await createTestOrg(sql, "B"));
    [orgA, orgB] = orgs.map((o) => o.organizationId);
    const [{ id: wb }] = await sql`insert into grid_workbooks (organization_id, name) values (${orgA}, 'w') returning id`;
    [{ id: tableA }] = await sql`
      insert into grid_tables (organization_id, workbook_id, name, position) values (${orgA}, ${wb}, 't', 1) returning id`;
    [{ id: rowA }] = await sql`insert into grid_rows (organization_id, table_id, position) values (${orgA}, ${tableA}, 1) returning id`;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("rejects a grid table under another tenant's workbook", async () => {
    const [{ id: wb }] = await sql`select id from grid_workbooks where organization_id = ${orgA} limit 1`;
    await expect(
      sql`insert into grid_tables (organization_id, workbook_id, name, position) values (${orgB}, ${wb}, 'x', 1)`,
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("rejects unknown column types and duplicate column keys", async () => {
    await expect(
      sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${orgA}, ${tableA}, 'a', 'A', 'bogus', 1)`,
    ).rejects.toThrow(/check/i);
    await sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${orgA}, ${tableA}, 'a', 'A', 'text', 1)`;
    await expect(
      sql`insert into grid_columns (organization_id, table_id, key, name, type, position) values (${orgA}, ${tableA}, 'a', 'A2', 'text', 2)`,
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("allows one job per cell", async () => {
    await sql`insert into grid_jobs (organization_id, table_id, row_id, column_key) values (${orgA}, ${tableA}, ${rowA}, 'a')`;
    await expect(
      sql`insert into grid_jobs (organization_id, table_id, row_id, column_key) values (${orgA}, ${tableA}, ${rowA}, 'a')`,
    ).rejects.toThrow(/unique|duplicate/i);
    await expect(
      sql`insert into grid_jobs (organization_id, table_id, row_id, column_key, status) values (${orgA}, ${tableA}, ${rowA}, 'b', 'running')`,
    ).rejects.toThrow(/check/i);
  });

  it("bumps the row version when cells change", async () => {
    const [before] = await sql`select version from grid_rows where id = ${rowA}`;
    await sql`update grid_rows set cells = '{"a": 1}'::jsonb where id = ${rowA}`;
    const [after] = await sql`select version from grid_rows where id = ${rowA}`;
    expect(Number(after.version)).toBeGreaterThan(Number(before.version));
  });

  it("requires an encryption envelope for provider credentials", async () => {
    const [{ id: account }] = await sql`
      insert into integration_accounts (organization_id, kind, key, name) values (${orgA}, 'enrichment', 'enrichment:apollo', 'apollo') returning id`;
    await expect(
      sql`insert into integration_credentials (account_id, encrypted_payload) values (${account}, 'sk-plaintext')`,
    ).rejects.toThrow(/check/i);
    await sql`insert into integration_credentials (account_id, encrypted_payload) values (${account}, 'v2:k:a:b:c')`;
  });

  it("keeps one draft version per flow and checks step semantics", async () => {
    const flow = await insertFollowUpFlow(sql, orgA, "s");
    const [{ id: ver }] = await sql`insert into follow_up_versions (organization_id, flow_id, version) values (${orgA}, ${flow}, 1) returning id`;
    await expect(
      sql`insert into follow_up_versions (organization_id, flow_id, version) values (${orgA}, ${flow}, 2)`,
    ).rejects.toThrow(/unique|duplicate/i);
    await expect(
      sql`insert into follow_up_versions (organization_id, flow_id, version, status) values (${orgA}, ${flow}, 3, 'published')`,
    ).rejects.toThrow(/check/i);
    await expect(
      sql`insert into follow_up_steps (organization_id, follow_up_version_id, position, step_type, name, delay_minutes, ai_instructions)
          values (${orgA}, ${ver}, 1, 'follow_up', 'x', 0, 'do it')`,
    ).rejects.toThrow(/check/i);
    await sql`insert into follow_up_steps (organization_id, follow_up_version_id, position, step_type, name, delay_minutes, ai_instructions)
              values (${orgA}, ${ver}, 1, 'reply', 'x', 0, 'do it')`;
    await expect(
      insertFollowUpFlow(sql, orgB, "s2").then((flow) =>
        sql`insert into follow_up_versions (organization_id, flow_id, version) values (${orgA}, ${flow}, 1)`),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
