import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";
import { FakeMailboxProvider } from "../fake-mailbox-provider";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [{ stepNumber: 1, kind: "email", subject: "Hi", body: "Hello", waitDays: 0 }];
const ADDRESS = "1 Main St, Seoul 04524";

describeDb("the sender postal address", () => {
  useTestEnv({ MAILBOX_PROVIDER: "gmail", APP_URL: "https://app.example.com" });
  const sql = testSql({ max: 4 });
  const orgs: TestOrg[] = [];

  async function draft() {
    const org = await createTestOrg(sql, "Postal");
    orgs.push(org);
    const tag = uniqueKey();
    const [{ id: mailbox }] = await sql`
      insert into mailboxes (organization_id, email_address, display_name, status, working_hours)
      values (${org.organizationId}, ${`s-${tag}@corp.test`}, 'S', 'connected', ${sql.json({ timeZone: "UTC", days: ALL_DAY })}) returning id`;
    const [{ id: campaignId }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${org.organizationId}, 'email', 'c', 'draft', ${sql.json(STEPS as never)}) returning id`;
    const [{ id: person }] = await sql`insert into people (organization_id, email, first_name) values (${org.organizationId}, ${`lead-${tag}@acme.test`}, 'L') returning id`;
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${org.organizationId}, ${campaignId}, ${person}, 'email')`;
    const actor = { organizationId: org.organizationId, userId: org.userId, role: "owner" as const };
    return { actor, campaignId: campaignId as string, mailbox: mailbox as string };
  }

  let management: typeof import("@/contexts/outreach/application/campaign-management");
  let composition: typeof import("@/contexts/outreach/infrastructure/composition");
  let rules: typeof import("../../application/email-rules");

  beforeAll(async () => {
    management = await import("@/contexts/outreach/application/campaign-management");
    composition = await import("@/contexts/outreach/infrastructure/composition");
    rules = await import("../../application/email-rules");
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  const save = (actor: Parameters<typeof rules.updateEmailRules>[1], senderPostalAddress: string) => rules.updateEmailRules(composition.emailRulesDeps(), actor, { minGapMinutes: 1, maxGapMinutes: 2, senderPostalAddress });

  it("refuses a start and lists the problem for a launch preview until the address is saved, and then carries it in the footer", async () => {
    const f = await draft();
    const refusal = "Add your postal address in Settings, Mailboxes, under Sending rules, before starting. CAN-SPAM requires one in commercial email.";
    await expect(management.changeCampaignStatus(composition.campaignDeps(), f.actor, f.campaignId, "active")).rejects.toThrow(refusal);
    expect((await management.campaignStartProblems(composition.campaignDeps(), f.actor, f.campaignId)).problems.map((p) => p.message)).toContain(refusal);

    expect((await save(f.actor, ` ${ADDRESS} `)).senderPostalAddress).toBe(ADDRESS);
    await management.changeCampaignStatus(composition.campaignDeps(), f.actor, f.campaignId, "active");
    expect((await management.previewStep(composition.campaignDeps(), f.actor, f.campaignId, 1)).bodyText).toContain(ADDRESS);

    const { sendNextEmail } = await import("../../application/send-next-email");
    const { drizzleOutreachStore } = await import("../drizzle-outreach-store");
    const provider = new FakeMailboxProvider();
    const outcome = await sendNextEmail({ store: drizzleOutreachStore, provider, clock: { now: () => new Date() }, random: () => 0, appUrl: "https://app.example.com", unsubscribeSecret: "u".repeat(40) }, f.mailbox);
    expect(outcome.kind).toBe("sent");
    const [send] = await sql`select body from sends s join campaign_enrollments e on e.id = s.enrollment_id where e.campaign_id = ${f.campaignId}`;
    expect(send.body).toContain(`---\n${ADDRESS}\n`);
  });

  it("keeps a saved address from going blank, and lets the rest of the form save while none is stored", async () => {
    const f = await draft();
    expect((await save(f.actor, "")).senderPostalAddress).toBeNull();
    await save(f.actor, ADDRESS);
    await expect(save(f.actor, "  ")).rejects.toThrow("Campaign email needs a postal address, so replace this one instead of clearing it.");
    expect((await save(f.actor, "2 Other St")).senderPostalAddress).toBe("2 Other St");
    await expect(save(f.actor, "x".repeat(301))).rejects.toThrow("Keep the postal address to 300 characters.");
  });
});
