import postgres from "postgres";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { expect, it } from "vitest";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";
import { adminAndScratchUrls } from "@/test-support/migration-test-kit";

/**
 * Query plans of the read indexes on 100k rows per table. It seeds a scratch database, checks with EXPLAIN that each query
 * uses its index, and prints the plan root before (index dropped inside a rolled-back transaction) and after. The people
 * table holds 200 contacts among the 100k, and 20,000 deals sit on them, for the Contacts list and the deal board.
 * Needs TEST_DATABASE_URL (any database on the test server).
 */
describeDb("read index query plans on 100k rows", () => {
  it("uses each index, and the plan without it does not", async () => {
    // A scratch database, so the 100k rows never touch the shared test database and cleanup is one DROP DATABASE.
    const name = `bench_plans_${Math.random().toString(36).slice(2, 8)}`;
    const urls = adminAndScratchUrls(TEST_DATABASE_URL ?? "", name);
    const admin = postgres(urls.admin, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`create database ${name}`);
    const db = postgres(urls.scratch, { max: 1, onnotice: () => undefined });
    try {
      await migrate(drizzle(db), { migrationsFolder: path.join(process.cwd(), "drizzle") });
      await runPlans(db);
    } finally {
      await db.end();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    }
  }, 300_000);
});

async function runPlans(sql: postgres.Sql) {
  const tag = Math.random().toString(36).slice(2, 8);
  const [{ id: org }] = await sql`insert into organizations (name, slug) values ('Perf', ${"perf-" + tag}) returning id`;
  const [{ id: other }] = await sql`insert into organizations (name, slug) values ('Perf2', ${"perf2-" + tag}) returning id`;
  const [{ id: user }] = await sql`insert into users (name, email) values ('U', ${tag + "@perf.test"}) returning id`;
  // The bulk seed skips triggers and foreign key checks (the cross-row validators reject classifications spread over records that
  // share one message). The plans below only need the row counts and the key distribution.
  await sql`set session_replication_role = replica`;
  await sql`insert into people (organization_id, email, full_name, created_at)
    select ${org}, 'p' || g || '@perf.test', 'Name ' || (g * 7919 % 100003), now() - (g || ' seconds')::interval from generate_series(1, 100000) g`;
  await sql`insert into people (organization_id, email, full_name)
    select ${other}, 'q' || g || '@perf.test', 'Other ' || g from generate_series(1, 20000) g`;
  // 200 contacts spread over the 100k, as a real organization converts a few leads out of many.
  await sql`update people set lifecycle = 'contact', converted_at = now() - ((abs(hashtext(id::text)) % 100000) || ' seconds')::interval
    where id in (select id from people where organization_id = ${org} order by md5(id::text) limit 200)`;
  const [{ id: pipeline }] = await sql`insert into pipelines (organization_id, name, is_default) values (${org}, 'p', true) returning id`;
  await sql`insert into records (organization_id, person_id, pipeline_id)
    select ${org}, id, ${pipeline} from (select id from people where organization_id = ${org} order by created_at limit 500) s`;
  const [{ id: record }] = await sql`select id from records where organization_id = ${org} limit 1`;
  await sql`insert into deal_stages (organization_id, name, kind, position) values (${org}, 'New', 'open', 1), (${org}, 'Meeting', 'open', 2), (${org}, 'Won', 'won', 3)`;
  const [{ id: newStage }] = await sql`select id from deal_stages where organization_id = ${org} and name = 'New'`;
  await sql`insert into deals (organization_id, person_id, stage_id, stage_kind, title, stage_changed_at, closed_at)
    select ${org}, c.id, s.id, s.kind, 'Deal ' || g, now() - (g || ' seconds')::interval, case when s.kind = 'open' then null else now() end
    from generate_series(1, 20000) g
    join lateral (select id from people where organization_id = ${org} and lifecycle = 'contact' order by id offset (g % 200) limit 1) c on true
    join lateral (select id, kind from deal_stages where organization_id = ${org} order by position offset (case when g % 10 < 7 then 0 when g % 10 < 9 then 1 else 2 end) limit 1) s on true`;
  const [{ id: dealPerson }] = await sql`select person_id as id from deals where organization_id = ${org} limit 1`;
  const [{ id: conversation }] = await sql`
    insert into conversations (organization_id, record_id, channel, account_ref) values (${org}, ${record}, 'email', 'me@perf.test') returning id`;
  const [{ id: message }] = await sql`
    insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
    values (${org}, ${conversation}, 'email', 'me@perf.test', 'inbound', ${"m-" + tag}, 'x', now()) returning id`;
  await sql`insert into classifications (organization_id, record_id, message_id, expected_context_version, confidence, created_at)
    select ${org}, r.id, ${message}, g, 0.5, now() - (g || ' seconds')::interval
    from generate_series(0, 99999) g join lateral (select id from records where organization_id = ${org} order by id offset (g % 500) limit 1) r on true`;
  const [{ id: person }] = await sql`select person_id as id from records where id = ${record}`;
  await sql`insert into events (organization_id, person_id, event_type, actor_type, created_at)
    select ${org}, p.person_id, 'e', 'system', now() - (g || ' seconds')::interval
    from generate_series(1, 100000) g join lateral (select person_id from records where organization_id = ${org} order by id offset (g % 500) limit 1) p on true`;
  const [{ id: draft }] = await sql`
    insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel) values (${org}, ${record}, ${conversation}, 0, 'email') returning id`;
  const draftIds = await sql`insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel)
    select ${org}, ${record}, ${conversation}, g, 'email' from generate_series(1, 499) g returning id`;
  expect(draftIds.length).toBe(499);
  await sql`insert into send_attempts (organization_id, draft_id, idempotency_key, actor_user_id, status, created_at)
    select ${org}, d.id, 'k-' || ${tag} || '-' || g, ${user}, 'failed', now() - (g || ' seconds')::interval
    from generate_series(1, 100000) g join lateral (select id from drafts where organization_id = ${org} order by id offset (g % 500) limit 1) d on true`;
  await sql`insert into identity_exceptions (organization_id, channel, account_ref, source_event_key, reason, status, resolved_at, created_at)
    select case when g % 5 = 0 then ${org}::uuid else ${other}::uuid end, 'email', 'a', 'e-' || ${tag} || '-' || g, 'r', 'ignored', now(), now() - (g || ' seconds')::interval
    from generate_series(1, 100000) g`;
  await sql`update identity_exceptions set status = 'open', resolved_at = null where organization_id = ${org} and created_at > now() - interval '3 hours'`;
  await sql`reset session_replication_role`;
  for (const t of ["people", "records", "classifications", "events", "drafts", "send_attempts", "identity_exceptions", "deal_stages", "deals"]) await sql.unsafe(`analyze ${t}`);

  const explain = async (query: string, params: unknown[]) => {
    const rows = await sql.unsafe(`explain (format json) ${query}`, params as never);
    return JSON.stringify(rows[0]["QUERY PLAN"]);
  };
  const root = (plan: string) => (plan.match(/"Node Type":"([^"]+)"/g) ?? []).map((m) => m.slice(13, -1)).join(" > ");
  const queries: Array<[string, string, string, unknown[]]> = [
    ["people_org_created_idx", "lead list, newest first", "select id from people where organization_id = $1 order by created_at desc, id desc limit 50", [org]],
    ["people_org_name_idx", "lead list, name ascending", "select id from people where organization_id = $1 order by lower(full_name) asc nulls last, id asc limit 50", [org]],
    ["classifications_record_created_idx", "classifications of a record", "select id from classifications where record_id = $1 order by created_at desc limit 20", [record]],
    ["events_person_created_idx", "events of a person", "select id from events where person_id = $1 order by created_at desc limit 50", [person]],
    ["send_attempts_draft_created_idx", "attempts of a draft", "select id from send_attempts where draft_id = $1 order by created_at desc limit 5", [draft]],
    ["identity_exceptions_org_status_created_idx", "exception queue", "select id from identity_exceptions where organization_id = $1 and status = 'open' order by created_at desc limit 200", [org]],
    // The default Leads list keeps the existing created_at index and filters on lifecycle.
    ["people_org_created_idx", "Leads list with lifecycle lead", "select id from people where organization_id = $1 and lifecycle = 'lead' order by created_at desc, id desc limit 50", [org]],
    ["people_org_contacts_idx", "Contacts list, newest conversion first", "select id from people where organization_id = $1 and lifecycle = 'contact' order by converted_at desc, id limit 25", [org]],
    ["deals_org_stage_idx", "board column, newest move first", "select id from deals where organization_id = $1 and stage_id = $2 order by stage_changed_at desc limit 25", [org, newStage]],
    ["deals_org_person_idx", "deals of a contact", "select id from deals where organization_id = $1 and person_id = $2", [org, dealPerson]],
  ];
  for (const [index, label, query, params] of queries) {
    const after = await explain(query, params);
    let before = "";
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`drop index ${index}`);
        const rows = await tx.unsafe(`explain (format json) ${query}`, params as never);
        before = JSON.stringify(rows[0]["QUERY PLAN"]);
        throw new Error("rollback");
      });
    } catch (error) {
      if ((error as Error).message !== "rollback") throw error;
    }
    console.log(`[plans] ${label}: before ${root(before)} | after ${root(after)}`);
    expect(after, label).toContain(index);
    expect(before, label).not.toContain(index);
  }
  await genericPlanCases(sql, org);
}

/**
 * A prepared statement with a generic plan cannot use a partial index when the predicate is a bound parameter, so the Contacts
 * list writes `lifecycle = 'contact'` as a literal. The literal form uses people_org_contacts_idx under a forced generic plan;
 * the parameter form does not.
 */
async function genericPlanCases(sql: postgres.Sql, org: string) {
  const plan = (statement: string, args: string) =>
    sql.begin(async (tx) => {
      await tx.unsafe("set local plan_cache_mode = force_generic_plan");
      await tx.unsafe(`prepare contacts_list as ${statement}`);
      const rows = await tx.unsafe(`explain (format json) execute contacts_list(${args})`);
      await tx.unsafe("deallocate contacts_list");
      return JSON.stringify(rows[0]["QUERY PLAN"]);
    });
  const literal = await plan("select id from people where organization_id = $1 and lifecycle = 'contact' order by converted_at desc, id limit 25", `'${org}'`);
  expect(literal, "literal predicate").toContain("people_org_contacts_idx");
  const bound = await plan("select id from people where organization_id = $1 and lifecycle = $2 order by converted_at desc, id limit 25", `'${org}', 'contact'`);
  expect(bound, "bound predicate").not.toContain("people_org_contacts_idx");
}
