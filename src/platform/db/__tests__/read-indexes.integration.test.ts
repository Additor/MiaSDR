import { afterAll, expect, it } from "vitest";
import { describeDb, testSql } from "../../../test-support/db";

/**
 * The read indexes exist with the planned columns. scripts/bench/read-indexes.bench.ts checks on 100k rows that each query
 * uses its index. Needs TEST_DATABASE_URL.
 */
const INDEXES: Array<[string, string, string]> = [
  ["people_org_created_idx", "people", "(organization_id, created_at, id)"],
  ["people_org_name_idx", "people", "(organization_id, lower(full_name), id)"],
  ["reply_type_picks_record_created_idx", "reply_type_picks", "(record_id, created_at)"],
  ["events_person_created_idx", "events", "(person_id, created_at)"],
  ["identity_exceptions_org_status_created_idx", "identity_exceptions", "(organization_id, status, created_at)"],
  ["knowledge_documents_org_active_idx", "knowledge_documents", "(organization_id, active, kind)"],
  ["send_attempts_draft_created_idx", "send_attempts", "(draft_id, created_at)"],
  ["people_org_contacts_idx", "people", "(organization_id, converted_at DESC, id)"],
  ["deals_org_stage_idx", "deals", "(organization_id, stage_id, stage_changed_at DESC)"],
  ["deals_org_person_idx", "deals", "(organization_id, person_id)"],
];

describeDb("read indexes", () => {
  const sql = testSql();
  afterAll(async () => {
    await sql.end();
  });

  it.each(INDEXES)("%s exists on %s %s", async (name, table, columns) => {
    const [row] = await sql`select indexdef from pg_indexes where schemaname = 'public' and tablename = ${table} and indexname = ${name}`;
    expect(row, `${name} is missing`).toBeDefined();
    expect(row.indexdef).toContain(columns);
  });
});
