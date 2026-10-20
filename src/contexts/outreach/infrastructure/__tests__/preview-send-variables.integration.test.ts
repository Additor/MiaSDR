import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { Actor } from "@/shared/errors";
import { renderLinkedInText } from "../../linkedin/domain/linkedin";

/**
 * The step preview, the lead list's note length and the send claim must resolve merge fields from the same data:
 * the person, the company, the person's unmapped import columns and the enrollment's own merge fields.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const BODY = "Hi {{firstName}}, I work with teams like {{company}}.";
const STEPS = [{ stepNumber: 1, kind: "invitation", body: BODY, waitDays: 0 }];

describeDb("preview and send resolve merge fields alike", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let campaignsApp: typeof import("../../linkedin/application/linkedin-campaigns");
  let composition: typeof import("../../linkedin/infrastructure/linkedin-composition");
  let store: typeof import("../../linkedin/infrastructure/drizzle-linkedin-store").drizzleLinkedInStore;
  let uc: typeof import("../../application/campaign-management");
  let stores: typeof import("../drizzle-management-stores");
  let admin: typeof import("../drizzle-enrollment-admin").drizzleEnrollmentAdminStore;
  const orgs: string[] = [];
  const users: string[] = [];

  async function linkedinLead(person: { companyName?: string; raw?: Record<string, string>; mergeFields?: Record<string, string> }) {
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('V', ${"pv-" + tag}) returning id`;
    orgs.push(org);
    const [{ id: userId }] = await sql`insert into users (name, email) values ('U', ${tag + "@pv.test"}) returning id`;
    users.push(userId);
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status, daily_invite_limit, working_hours)
      values (${org}, ${"acct-" + tag}, ${"ACo-owner-" + tag}, ${"owner-" + tag}, 'connected', 20, ${sql.json({ timeZone: "UTC", days: ALL_DAY } as never)}) returning id`;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${org}, 'linkedin', 'c', 'active', ${sql.json(STEPS as never)}) returning id`;
    let companyId: string | null = null;
    if (person.companyName) [{ id: companyId }] = await sql`insert into companies (organization_id, name) values (${org}, ${person.companyName}) returning id`;
    const [{ id: personId }] = await sql`
      insert into people (organization_id, linkedin_slug, first_name, full_name, company_id, raw)
      values (${org}, ${"ada-" + tag}, 'Ada', 'Ada Lovelace', ${companyId}, ${person.raw ? sql.json(person.raw as never) : null}) returning id`;
    const [{ id: enrollment }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, linkedin_account_id, merge_fields)
      values (${org}, ${campaign}, ${personId}, 'linkedin', 'pending', 0, ${account}, ${sql.json((person.mergeFields ?? {}) as never)}) returning id`;
    await sql`
      insert into linkedin_enrollment_details (enrollment_id, organization_id, provider_id, profile_url, connection_state)
      values (${enrollment}, ${org}, ${"ACo-ada-" + tag}, ${"https://www.linkedin.com/in/ada-" + tag}, 'none')`;
    const actor: Actor = { userId, organizationId: org, role: "owner" };
    return { org, campaign, account, actor, enrollment };
  }
  type Lead = Awaited<ReturnType<typeof linkedinLead>>;

  /** The three readers of one lead: step preview, lead list, and the variables the send claim renders with. */
  async function readers(f: Lead) {
    const deps = composition.linkedinCampaignDeps();
    const preview = await campaignsApp.previewLinkedInStep(deps, f.actor, f.campaign, 1);
    const detail = await campaignsApp.getLinkedInCampaignDetail(deps, f.actor, f.campaign, { tab: "all", query: "", page: 1, pageSize: 50 } as never);
    const claim = await store.claimNext({ accountId: f.account, now: new Date("2026-10-14T10:00:00Z"), random: () => 0, defaultWorkingHours: () => ({ timeZone: "UTC", days: ALL_DAY as never }) });
    if (!claim || claim.kind !== "invitation") throw new Error(`expected an invitation claim, got ${claim?.kind ?? "none"}`);
    return { preview, noteLength: detail.enrollments.rows[0].noteLength, sent: renderLinkedInText(BODY, claim.person.variables, () => 0) };
  }

  beforeAll(async () => {
    campaignsApp = await import("../../linkedin/application/linkedin-campaigns");
    composition = await import("../../linkedin/infrastructure/linkedin-composition");
    ({ drizzleLinkedInStore: store } = await import("../../linkedin/infrastructure/drizzle-linkedin-store"));
    uc = await import("../../application/campaign-management");
    stores = await import("../drizzle-management-stores");
    ({ drizzleEnrollmentAdminStore: admin } = await import("../drizzle-enrollment-admin"));
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    } finally {
      await sql.end();
    }
  });

  it("a company held only in the enrollment's merge fields fills the preview, the note length and the send alike", async () => {
    const f = await linkedinLead({ mergeFields: { company: "Acme Corp" } });
    const { preview, noteLength, sent } = await readers(f);
    expect(sent).toBe("Hi Ada, I work with teams like Acme Corp.");
    expect(preview.text).toBe(sent);
    expect(preview.unresolved).toEqual([]);
    expect(noteLength).toBe(sent.length);
  });

  it("a company held only in the person's unmapped import columns fills all three alike", async () => {
    const f = await linkedinLead({ raw: { company: "Beta LLC" } });
    const { preview, noteLength, sent } = await readers(f);
    expect(sent).toBe("Hi Ada, I work with teams like Beta LLC.");
    expect(preview.text).toBe(sent);
    expect(noteLength).toBe(sent.length);
  });

  it("a lead with no company anywhere is empty in all three, and the preview names the token", async () => {
    const f = await linkedinLead({});
    const { preview, noteLength, sent } = await readers(f);
    expect(sent).toBe("Hi Ada, I work with teams like.");
    expect(preview.text).toBe(sent);
    expect(preview.unresolved).toEqual([{ token: "company", reason: "empty" }]);
    expect(noteLength).toBe(sent.length);
  });

  it("the email preview also uses the enrolled lead's merge fields", async () => {
    const f = await linkedinLead({});
    await sql`update people set email = ${`ada-${f.org.slice(0, 6)}@pv.test`} where organization_id = ${f.org}`;
    const [{ id }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'email', 'e', 'draft', '[]'::jsonb) returning id`;
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, merge_fields)
      select organization_id, ${id}, person_id, 'email', 'pending', ${sql.json({ company: "Acme Corp" } as never)} from campaign_enrollments where id = ${f.enrollment}`;
    const preview = await uc.previewStep({ campaigns: stores.drizzleCampaignStore, mailboxes: stores.drizzleMailboxStore, admin }, f.actor, id, 1, [
      { stepNumber: 1, kind: "email", subject: "Hi {{firstName}}", body: "Teams like {{company}}.", waitDays: 0 },
    ]);
    expect(preview.bodyText).toContain("Teams like Acme Corp.");
    expect(preview.unresolved).toEqual([]);
  });
});
