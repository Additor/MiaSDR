import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, type TestOrg } from "../../../test-support/db";

/** Constraint checks for the sequence and grid tables. Set TEST_DATABASE_URL to enable. */
describeDb("sequence and grid invariants", () => {
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
    const [{ id: provider }] = await sql`
      insert into grid_providers (organization_id, key, name) values (${orgA}, 'apollo', 'Apollo') returning id`;
    await expect(
      sql`insert into grid_provider_credentials (provider_id, organization_id, encrypted_payload) values (${provider}, ${orgA}, 'sk-plaintext')`,
    ).rejects.toThrow(/check/i);
    await sql`insert into grid_provider_credentials (provider_id, organization_id, encrypted_payload) values (${provider}, ${orgA}, 'v1:a:b:c')`;
  });

  it("keeps one draft version per sequence and checks step semantics", async () => {
    const [{ id: seq }] = await sql`insert into sequences (organization_id, name) values (${orgA}, 's') returning id`;
    const [{ id: ver }] = await sql`insert into sequence_versions (organization_id, sequence_id, version) values (${orgA}, ${seq}, 1) returning id`;
    await expect(
      sql`insert into sequence_versions (organization_id, sequence_id, version) values (${orgA}, ${seq}, 2)`,
    ).rejects.toThrow(/unique|duplicate/i);
    await expect(
      sql`insert into sequence_versions (organization_id, sequence_id, version, status) values (${orgA}, ${seq}, 3, 'published')`,
    ).rejects.toThrow(/check/i);
    await expect(
      sql`insert into sequence_steps (organization_id, sequence_version_id, position, step_type, name, delay_minutes, ai_instructions)
          values (${orgA}, ${ver}, 1, 'follow_up', 'x', 0, 'do it')`,
    ).rejects.toThrow(/check/i);
    await sql`insert into sequence_steps (organization_id, sequence_version_id, position, step_type, name, delay_minutes, ai_instructions)
              values (${orgA}, ${ver}, 1, 'reply', 'x', 0, 'do it')`;
    await expect(
      sql`insert into sequences (organization_id, name) values (${orgB}, 's2') returning id`.then(([r]) =>
        sql`insert into sequence_versions (organization_id, sequence_id, version) values (${orgA}, ${r.id}, 1)`),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
