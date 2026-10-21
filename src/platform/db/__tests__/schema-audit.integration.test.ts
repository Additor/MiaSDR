import { afterAll, expect, it } from "vitest";
import { describeDb, testSql } from "../../../test-support/db";
import { INDEX_DEBT, INDEX_DEBT_REASON, NO_SCOPE, NULLABLE_SCOPE, auditSchema, tableFacts } from "../schema-audit";

/**
 * Every public table is tenant-scoped or named in an allow-list with a reason. Needs TEST_DATABASE_URL.
 * A new table without `organization_id`, a nullable one, one without the foreign key or one without an index fails here.
 */
describeDb("schema audit (organization scope)", () => {
  const sql = testSql({ max: 1 });
  const scratch = "t8_scratch_audit";

  afterAll(async () => {
    await sql.unsafe(`drop table if exists ${scratch}`);
    await sql.end();
  });

  async function withScratch(ddl: string): Promise<string[]> {
    await sql.unsafe(`drop table if exists ${scratch}`);
    try {
      await sql.unsafe(ddl);
      return (await auditSchema(sql)).filter((p) => p.includes(scratch));
    } finally {
      await sql.unsafe(`drop table if exists ${scratch}`);
    }
  }

  it("finds no problem in the current schema", async () => {
    expect(await auditSchema(sql)).toEqual([]);
  });

  it("lists the allow-lists, each entry with a reason", () => {
    expect(Object.keys(NO_SCOPE).sort()).toEqual(["accounts", "integration_credentials", "organizations", "sessions", "users", "verifications"]);
    expect(Object.keys(NULLABLE_SCOPE).sort()).toEqual(["inbound_events", "job_runs"]);
    for (const list of [NO_SCOPE, NULLABLE_SCOPE, INDEX_DEBT]) {
      for (const reason of Object.values(list)) expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("keeps INDEX_DEBT at its 15 tables, each with the shared reason", () => {
    // The audit reports an entry that gained an index, but not a new entry: this list is the only check that INDEX_DEBT does not grow.
    expect(Object.keys(INDEX_DEBT).sort()).toEqual([
      "campaign_senders", "draft_knowledge_citations", "events", "grid_columns", "grid_provider_credentials",
      "grid_user_views", "linkedin_connections", "linkedin_enrollment_details",
      "linkedin_search_results", "notes", "pipeline_settings", "record_sequence_overrides", "send_attempts", "sequence_step_runs",
      "subcategory_sequence_assignments",
    ]);
    for (const reason of Object.values(INDEX_DEBT)) expect(reason).toBe(INDEX_DEBT_REASON);
    expect(INDEX_DEBT_REASON).toContain("organization deletion is disabled");
  });

  it("indexes the four tables an organization-filtered query reads", async () => {
    const rows = await sql`select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname in ('grid_jobs_org_status_idx', 'sends_org_status_idx', 'ai_jobs_org_failed_idx', 'contact_policies_org_dnc_idx') order by indexname`;
    expect(rows.map((r) => r.indexname)).toEqual(["ai_jobs_org_failed_idx", "contact_policies_org_dnc_idx", "grid_jobs_org_status_idx", "sends_org_status_idx"]);
    const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef as string;
    expect(def("grid_jobs_org_status_idx")).toContain("(organization_id, status)");
    expect(def("sends_org_status_idx")).toContain("(organization_id, status)");
    expect(def("ai_jobs_org_failed_idx")).toContain("(organization_id, failed_at) WHERE (status = 'failed'::text)");
    expect(def("contact_policies_org_dnc_idx")).toContain("WHERE do_not_contact");
  });

  it("indexes linkedin search batches and queries by organization and creation time", async () => {
    const rows = await sql`select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname in ('linkedin_search_batches_org_created_idx', 'linkedin_search_queries_org_created_idx') order by indexname`;
    expect(rows.map((r) => r.indexname)).toEqual(["linkedin_search_batches_org_created_idx", "linkedin_search_queries_org_created_idx"]);
    for (const r of rows) expect(r.indexdef).toContain("(organization_id, created_at)");
  });

  it("covers every public table", async () => {
    const facts = await tableFacts(sql);
    expect(facts.length).toBeGreaterThan(60);
    const unscoped = facts.filter((f) => !f.has_org).map((f) => f.table).sort();
    expect(unscoped).toEqual(Object.keys(NO_SCOPE).sort());
  });

  it("rejects a table with no organization_id", async () => {
    const found = await withScratch(`create table ${scratch} (id uuid primary key)`);
    expect(found).toEqual([expect.stringMatching(/has no organization_id column/)]);
  });

  it("rejects a nullable organization_id", async () => {
    const found = await withScratch(
      `create table ${scratch} (id uuid primary key, organization_id uuid references organizations(id)); create index on ${scratch} (organization_id)`,
    );
    expect(found).toEqual([expect.stringMatching(/organization_id is nullable/)]);
  });

  it("rejects a missing foreign key", async () => {
    const found = await withScratch(`create table ${scratch} (id uuid primary key, organization_id uuid not null); create index on ${scratch} (organization_id)`);
    expect(found).toEqual([expect.stringMatching(/no foreign key to organizations/)]);
  });

  it("rejects a missing index", async () => {
    const found = await withScratch(`create table ${scratch} (id uuid primary key, organization_id uuid not null references organizations(id))`);
    expect(found).toEqual([expect.stringMatching(/no index that contains organization_id/)]);
  });

  it("accepts a table that meets every rule", async () => {
    const found = await withScratch(
      `create table ${scratch} (id uuid primary key, organization_id uuid not null references organizations(id)); create index on ${scratch} (organization_id)`,
    );
    expect(found).toEqual([]);
  });

  it("reports an index that makes an INDEX_DEBT entry stale", async () => {
    await sql`create index t8_scratch_events_org_idx on events (organization_id)`;
    try {
      const found = (await auditSchema(sql)).filter((p) => p.startsWith("events "));
      expect(found).toEqual([expect.stringMatching(/INDEX_DEBT/)]);
    } finally {
      await sql`drop index if exists t8_scratch_events_org_idx`;
    }
  });
});
