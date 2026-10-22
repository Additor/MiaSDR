import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";

/**
 * Times the lead list on a 10,000-lead organization: the lead status batch for one page and the replied and last-contact
 * filters. Needs TEST_DATABASE_URL pointing at a migrated Postgres. Env: BENCH_LEADS.
 */
const LEADS = Number(process.env.BENCH_LEADS ?? 10_000);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describeDb("lead list benchmark", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let outreach: typeof import("@/contexts/outreach/infrastructure/drizzle-lead-statuses");
  let q: typeof import("@/contexts/people/infrastructure/queries");
  let org: TestOrg;

  beforeAll(async () => {
    outreach = await import("@/contexts/outreach/infrastructure/drizzle-lead-statuses");
    q = await import("@/contexts/people/infrastructure/queries");
    org = await createTestOrg(sql, "Bench");
    const o = org.organizationId;
    const [{ id: pipeline }] = await sql`insert into pipelines (organization_id, name, is_default) values (${o}, 'default', true) returning id`;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, type) values (${o}, 'email', 'Big', 'active', 'regular') returning id`;
    await sql`insert into people (organization_id, email, full_name)
      select ${o}, 'bulk' || g || '-' || ${org.slug} || '@la.test', 'Bulk ' || g from generate_series(1, ${LEADS}) g`;
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status)
      select ${o}, ${campaign}, id, 'email', case when random() < 0.1 then 'replied' else 'active' end from people where organization_id = ${o}`;
    await sql`insert into records (organization_id, person_id, pipeline_id) select ${o}, id, ${pipeline} from people where organization_id = ${o}`;
    await sql`insert into conversations (organization_id, record_id, channel, account_ref) select ${o}, id, 'email', ${"bulk-" + org.slug} from records where organization_id = ${o}`;
    await sql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      select ${o}, c.id, 'email', ${"bulk-" + org.slug}, 'outbound', 'bulk-' || c.id, 'hello', now() - (random() * interval '60 days') from conversations c where c.organization_id = ${o}`;
    for (const table of ["people", "campaign_enrollments", "messages", "conversations", "records"]) await sql`analyze ${sql(table)}`;
  }, 600_000);

  afterAll(async () => {
    await dropOrgs(sql, [org]);
    await sql.end();
  });

  const timed = async <T>(run: () => Promise<T>) => {
    const start = performance.now();
    const value = await run();
    return { value, ms: performance.now() - start };
  };

  it("reads the lead status of a page and the filtered lists", async () => {
    const o = org.organizationId;
    const page = await q.listLeads(o, { pageSize: 200 });
    const batch = await timed(() => outreach.readLeadStatuses(o, page.rows.map((r) => r.id)));
    expect(batch.value.size).toBe(200);
    const replied = await timed(() => q.listLeads(o, { filter: { replied: true }, pageSize: 200 }));
    const lastFrom = await timed(() => q.listLeads(o, { filter: { lastContactFrom: day(-20) }, pageSize: 200 }));
    const lastTo = await timed(() => q.listLeads(o, { filter: { lastContactTo: day(-40) }, pageSize: 200 }));
    console.table([
      { read: "lead status, 200 ids", ms: Math.round(batch.ms), rows: batch.value.size },
      { read: "replied filter", ms: Math.round(replied.ms), rows: replied.value.total },
      { read: "last contact from", ms: Math.round(lastFrom.ms), rows: lastFrom.value.total },
      { read: "last contact to", ms: Math.round(lastTo.ms), rows: lastTo.value.total },
    ]);
  });
});
