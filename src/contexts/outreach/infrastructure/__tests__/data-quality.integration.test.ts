import { drizzleEnrollmentAdminStore } from "../drizzle-enrollment-admin";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import type { Actor } from "@/shared/errors";
import { ValidationError } from "@/shared/errors";
import { FakeMailboxProvider } from "../../email/infrastructure/fake-mailbox-provider";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const step = (subject: string, body: string) => ({ stepNumber: 1, kind: "email", subject, body, waitDays: 0 });

describeDb("import to campaign data quality", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let importLeads: typeof import("@/contexts/leads/application/import-leads").importLeads;
  let leadStore: typeof import("@/contexts/leads/infrastructure/drizzle-lead-store").drizzleLeadStore;
  let suggestMapping: typeof import("@/contexts/leads/domain/import-plan").suggestMapping;
  let uc: typeof import("../../application/campaign-management");
  let stores: typeof import("../drizzle-management-stores");
  let send: typeof import("../../email/application/send-next-email");
  let engineStore: typeof import("../drizzle-outreach-store").drizzleOutreachStore;
  let mergeFields: typeof import("../../application/merge-fields");
  let mergeSource: typeof import("../drizzle-merge-fields").drizzleMergeFieldSource;
  const orgs: TestOrg[] = [];

  async function org() {
    const owner = await createTestOrg(sql, "Q");
    orgs.push(owner);
    const { organizationId: id, userId, slug: tag } = owner;
    const actor: Actor = { userId, organizationId: id, role: "owner" };
    return { actor, id, userId, tag };
  }

  async function runImport(t: Awaited<ReturnType<typeof org>>, headers: string[], rows: Array<Record<string, string>>) {
    return importLeads({ store: leadStore }, { organizationId: t.id, userId: t.userId, filename: "f.csv", headers, rows, mapping: suggestMapping(headers) });
  }

  beforeAll(async () => {
    ({ importLeads } = await import("@/contexts/leads/application/import-leads"));
    ({ drizzleLeadStore: leadStore } = await import("@/contexts/leads/infrastructure/drizzle-lead-store"));
    ({ suggestMapping } = await import("@/contexts/leads/domain/import-plan"));
    uc = await import("../../application/campaign-management");
    stores = await import("../drizzle-management-stores");
    send = await import("../../email/application/send-next-email");
    ({ drizzleOutreachStore: engineStore } = await import("../drizzle-outreach-store"));
    mergeFields = await import("../../application/merge-fields");
    ({ drizzleMergeFieldSource: mergeSource } = await import("../drizzle-merge-fields"));
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  const campaignDeps = () => ({ campaigns: stores.drizzleCampaignStore, mailboxes: stores.drizzleMailboxStore, admin: drizzleEnrollmentAdminStore });

  it("a file with only Name fills the first-name merge field", async () => {
    const t = await org();
    await runImport(t, ["Email", "Name"], [{ Email: `a@${t.tag}.com`, Name: "Mary Ann Smith" }]);
    const [p] = await sql`select first_name, last_name, full_name from people where organization_id = ${t.id}`;
    expect(p).toMatchObject({ first_name: "Mary", last_name: "Ann Smith", full_name: "Mary Ann Smith" });
  });

  it("a company-only column keeps the name: inferred domain for work mail, raw for webmail", async () => {
    const t = await org();
    await runImport(t, ["Email", "Company"], [
      { Email: `a@${t.tag}.com`, Company: "Acme Inc" },
      { Email: `b@gmail.com`, Company: "Beta LLC" },
    ]);
    const [work] = await sql`select p.raw, c.domain, c.name from people p left join companies c on c.id = p.company_id where p.organization_id = ${t.id} and p.email = ${`a@${t.tag}.com`}`;
    expect(work).toMatchObject({ domain: `${t.tag}.com`, name: "Acme Inc", raw: null });
    const [web] = await sql`select p.raw, c.domain from people p left join companies c on c.id = p.company_id where p.organization_id = ${t.id} and p.email = 'b@gmail.com'`;
    expect(web).toMatchObject({ domain: null, raw: { company: "Beta LLC" } });
  });

  it("stores the company LinkedIn page on the company", async () => {
    const t = await org();
    await runImport(t, ["Email", "Website", "Company LinkedIn"], [{ Email: `a@x.com`, Website: `${t.tag}.com`, "Company LinkedIn": "linkedin.com/company/acme" }]);
    const [c] = await sql`select linkedin_url from companies where organization_id = ${t.id}`;
    expect(c.linkedin_url).toBe("https://www.linkedin.com/company/acme/");
  });

  it("renders {{jobTitle}}, a default custom column and a company-less name in a preview, and lists unresolved tokens", async () => {
    const t = await org();
    await runImport(t, ["Email", "Name", "Job Title", "Seniority", "Company"], [{ Email: `a@gmail.com`, Name: "Mary Smith", "Job Title": "CTO", Seniority: "Senior", Company: "Beta LLC" }]);
    const { id } = await uc.createCampaign(campaignDeps(), t.actor, { name: "c" });
    const preview = await uc.previewStep(campaignDeps(), t.actor, id, 1, [
      { stepNumber: 1, kind: "email", subject: "Hi {{firstName}}", body: "{{jobTitle}} / {{seniority}} / {{Seniority}} / {{company}} / {{name}} {{firstNme}} {{linkedinUrl}}", waitDays: 0 },
    ]);
    expect(preview.usedSampleLead).toBe(false);
    expect(preview.subject).toBe("Hi Mary");
    expect(preview.bodyText).toContain("CTO / Senior / Senior / Beta LLC / Mary Smith");
    expect(preview.unresolved).toEqual([
      { token: "firstNme", reason: "unknown" },
      { token: "linkedinUrl", reason: "empty" },
    ]);
  });

  it("refuses to launch when the first subject renders empty, and launches with a subject", async () => {
    const t = await org();
    await runImport(t, ["Email", "Name"], [{ Email: `a@${t.tag}.com`, Name: "Mary" }]);
    await sql`insert into mailboxes (organization_id, email_address, status, working_hours) values (${t.id}, ${`s@${t.tag}.test`}, 'connected', ${sql.json({ timeZone: "UTC", days: ALL_DAY })})`;
    const { id } = await uc.createCampaign(campaignDeps(), t.actor, { name: "c" });
    await uc.updateCampaign(campaignDeps(), t.actor, id, { steps: [{ stepNumber: 1, kind: "email", subject: "{{firstNme}}", body: "Hello", waitDays: 0 }] });
    await expect(uc.changeCampaignStatus(campaignDeps(), t.actor, id, "active")).rejects.toThrow(/subject of step 1 renders empty/);
    await expect(uc.changeCampaignStatus(campaignDeps(), t.actor, id, "active")).rejects.toBeInstanceOf(ValidationError);
    await uc.updateCampaign(campaignDeps(), t.actor, id, { steps: [{ stepNumber: 1, kind: "email", subject: "{{firstName}} hi", body: "Hello", waitDays: 0 }] });
    await uc.changeCampaignStatus(campaignDeps(), t.actor, id, "active");
    const [row] = await sql`select status from campaigns where id = ${id}`;
    expect(row.status).toBe("active");
  });

  it("does not send an email whose first subject renders empty for that lead", async () => {
    const t = await org();
    const [{ id: mailbox }] = await sql`
      insert into mailboxes (organization_id, email_address, status, daily_send_limit, working_hours)
      values (${t.id}, ${`s@${t.tag}.test`}, 'connected', 30, ${sql.json({ timeZone: "UTC", days: ALL_DAY })}) returning id`;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${t.id}, 'email', 'c', 'active', ${sql.json([step("{{company}}", "Hello")] as never)}) returning id`;
    // Lead without any company: the subject renders empty. A second lead with a company still sends.
    const [{ id: p1 }] = await sql`insert into people (organization_id, email, first_name, created_at) values (${t.id}, ${`one@${t.tag}.test`}, 'One', now() - interval '1 minute') returning id`;
    const [{ id: co }] = await sql`insert into companies (organization_id, domain, name) values (${t.id}, ${`${t.tag}.com`}, 'Acme') returning id`;
    const [{ id: p2 }] = await sql`insert into people (organization_id, email, first_name, company_id) values (${t.id}, ${`two@${t.tag}.test`}, 'Two', ${co}) returning id`;
    const [{ id: e1 }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, created_at) values (${t.id}, ${campaign}, ${p1}, 'email', now() - interval '1 minute') returning id`;
    const [{ id: e2 }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${t.id}, ${campaign}, ${p2}, 'email') returning id`;
    const provider = new FakeMailboxProvider();
    let now = new Date();
    const deps = { store: engineStore, provider, clock: { now: () => now }, random: () => 0, appUrl: "https://app.test", unsubscribeSecret: "u".repeat(40) };
    const first = await send.sendNextEmail(deps, mailbox);
    expect(first).toEqual({ kind: "failed", retry: false });
    expect(provider.delivered).toHaveLength(0);
    const [blocked] = await sql`select status, stop_reason from campaign_enrollments where id = ${e1}`;
    expect(blocked.status).toBe("failed");
    expect(blocked.stop_reason).toMatch(/Subject is empty for this lead/);
    now = new Date(now.getTime() + 60 * 60_000);
    expect((await send.sendNextEmail(deps, mailbox)).kind).toBe("sent");
    expect(provider.delivered.map((m) => m.subject)).toEqual(["Acme"]);
    const [ok] = await sql`select status from campaign_enrollments where id = ${e2}`;
    expect(ok.status).toBe("completed");
  });

  it("lists merge fields: standard, custom columns by camelCase name, and source data keys", async () => {
    const t = await org();
    await runImport(t, ["Email", "Job Title", "Seniority", "Notes (internal)"], [{ Email: `a@${t.tag}.com`, "Job Title": "CTO", Seniority: "Senior", "Notes (internal)": "x" }]);
    await sql`update people set raw = ${sql.json({ Region: "EMEA", company: "Raw Co" })} where organization_id = ${t.id}`;
    const fields = await mergeFields.listMergeFields({ source: mergeSource }, t.actor);
    const tokens = fields.map((f) => f.token);
    expect(tokens).toEqual(expect.arrayContaining(["firstName", "company", "linkedinUrl", "seniority", "notesInternal", "Region"]));
    expect(tokens).not.toContain("jobTitle");
    expect(tokens).not.toContain("company_linkedin_url");
    expect(fields.find((f) => f.token === "seniority")).toMatchObject({ group: "custom", label: "Seniority" });
    expect(fields.find((f) => f.token === "Region")?.group).toBe("source");
    expect(new Set(tokens.map((x) => x.toLowerCase())).size).toBe(tokens.length);
  });

  it("does not list another organization's columns", async () => {
    const a = await org();
    const b = await org();
    await runImport(a, ["Email", "Secret Field"], [{ Email: `a@${a.tag}.com`, "Secret Field": "v" }]);
    const tokens = (await mergeFields.listMergeFields({ source: mergeSource }, b.actor)).map((f) => f.token);
    expect(tokens).not.toContain("secretField");
  });
});
