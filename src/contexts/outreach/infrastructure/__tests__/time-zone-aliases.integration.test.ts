import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import type { Actor } from "@/shared/errors";
import { drizzleAuditSink } from "../../linkedin/infrastructure/drizzle-linkedin-operations-store";
import { FakeLinkedInGateway } from "../../linkedin/infrastructure/fake-linkedin-gateway";
import { FakeMailboxProvider } from "../../email/infrastructure/fake-mailbox-provider";

vi.mock("server-only", () => ({}));

/** A legacy ICU id (Asia/Calcutta) must reach storage as the current IANA name. */
describeDb("time zone aliases at every write point", () => {
  useTestEnv({ APP_URL: "https://app.example.com" });
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];
  let m: {
    rules: typeof import("../../email/application/email-rules");
    settings: typeof import("../drizzle-channel-settings-store");
    mailboxUc: typeof import("../../email/application/mailbox-management");
    stores: typeof import("../drizzle-management-stores");
    linkedin: typeof import("../../linkedin/application/linkedin-management");
    accounts: typeof import("../../linkedin/infrastructure/drizzle-linkedin-account-store");
    connect: typeof import("../../linkedin/infrastructure/drizzle-linkedin-connect-store");
    orgUc: typeof import("@/contexts/tenancy/application/organization-settings");
    orgStore: typeof import("@/contexts/tenancy/infrastructure/organization-composition");
    analytics: typeof import("@/contexts/analytics/application/analytics-queries");
    analyticsStore: typeof import("@/contexts/analytics/infrastructure/drizzle-analytics-read-model");
  };

  async function org() {
    const owner = await createTestOrg(sql, "Z");
    orgs.push(owner);
    const { organizationId: id, userId, slug: tag } = owner;
    return { id, tag, actor: { userId, organizationId: id, role: "owner" } as Actor };
  }

  beforeAll(async () => {
    m = {
      rules: await import("../../email/application/email-rules"),
      settings: await import("../drizzle-channel-settings-store"),
      mailboxUc: await import("../../email/application/mailbox-management"),
      stores: await import("../drizzle-management-stores"),
      linkedin: await import("../../linkedin/application/linkedin-management"),
      accounts: await import("../../linkedin/infrastructure/drizzle-linkedin-account-store"),
      connect: await import("../../linkedin/infrastructure/drizzle-linkedin-connect-store"),
      orgUc: await import("@/contexts/tenancy/application/organization-settings"),
      orgStore: await import("@/contexts/tenancy/infrastructure/organization-composition"),
      analytics: await import("@/contexts/analytics/application/analytics-queries"),
      analyticsStore: await import("@/contexts/analytics/infrastructure/drizzle-analytics-read-model"),
    };
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("organization settings store the current name and audit it", async () => {
    const t = await org();
    const deps = m.orgStore.organizationDeps();
    const view = await m.orgUc.updateOrganization(deps, t.actor, { timeZone: "Asia/Calcutta" });
    expect(view.timeZone).toBe("Asia/Kolkata");
    const [row] = await sql`select timezone from organizations where id = ${t.id}`;
    expect(row.timezone).toBe("Asia/Kolkata");
    const [general] = await sql`select values from channel_settings where organization_id = ${t.id} and channel = 'general'`;
    expect(general.values.timeZone).toBe("Asia/Kolkata");
    const [audit] = await sql`select meta from audit_log where organization_id = ${t.id} and action = 'organization.timezone_changed'`;
    expect(audit.meta.to).toBe("Asia/Kolkata");
    // Saving the old name again is a no-op: the stored zone already is that zone.
    await m.orgUc.updateOrganization(deps, t.actor, { timeZone: "Asia/Calcutta" });
    expect(await sql`select 1 from audit_log where organization_id = ${t.id} and action = 'organization.timezone_changed'`).toHaveLength(1);
    await expect(m.orgUc.updateOrganization(deps, t.actor, { timeZone: "Mars/Base" })).rejects.toThrow("Unknown time zone.");
  });

  it("email rules store and read the current name, including a legacy value already stored", async () => {
    const t = await org();
    const deps = { settings: m.settings.drizzleChannelSettingsStore };
    await m.rules.updateEmailRules(deps, t.actor, { minGapMinutes: 5, maxGapMinutes: 9, timeZone: "Europe/Kiev" });
    const [general] = await sql`select values from channel_settings where organization_id = ${t.id} and channel = 'general'`;
    expect(general.values.timeZone).toBe("Europe/Kyiv");
    await sql`update channel_settings set values = ${sql.json({ timeZone: "Asia/Saigon" })} where organization_id = ${t.id} and channel = 'general'`;
    expect((await m.rules.getEmailRules(deps, t.actor)).timeZone).toBe("Asia/Ho_Chi_Minh");
  });

  it("mailbox working hours store the current name", async () => {
    const t = await org();
    const deps = { mailboxes: m.stores.drizzleMailboxStore, provider: new FakeMailboxProvider(), now: () => new Date("2026-10-14T10:00:00Z"), policy: { allowedDomains: null, openSignup: false } };
    const { id } = await m.mailboxUc.connectMailbox(deps, t.actor, { emailAddress: `tz${t.tag}@corp.test` });
    await m.mailboxUc.updateMailbox(deps, t.actor, id, { workingHours: { timeZone: "Asia/Katmandu", days: { "1": [{ start: "09:00", end: "17:00" }] } } });
    expect(await m.stores.drizzleMailboxStore.get(t.id, id)).toMatchObject({ workingHours: { timeZone: "Asia/Kathmandu" } });
  });

  it("LinkedIn account working hours store the current name", async () => {
    const t = await org();
    const gateway = new FakeLinkedInGateway();
    gateway.accounts = [{ ref: "u-" + t.tag, linkedinId: "ACo-" + t.tag, name: "Ada", username: "ada-" + t.tag, status: "connected" }];
    const deps: import("../../linkedin/application/linkedin-management").LinkedInManagementDeps = { accounts: m.accounts.drizzleLinkedInAccountStore, gatewayFor: () => gateway, appUrl: "https://app.example.com", now: () => new Date("2026-10-14T10:00:00Z"), audit: drizzleAuditSink, connectLinks: m.connect.drizzleLinkedInConnectStore };
    await m.linkedin.connectLinkedIn(deps, t.actor, { dsn: "api1.unipile.com:13111", apiKey: "k" });
    const [account] = (await m.linkedin.listLinkedInAccounts(deps, t.actor)).accounts;
    await m.linkedin.updateLinkedInAccount(deps, t.actor, account.id, { workingHours: { timeZone: "Asia/Rangoon", days: { "1": [{ start: "09:00", end: "17:00" }] } } });
    const [row] = await sql`select working_hours from linkedin_accounts where id = ${account.id}`;
    expect(row.working_hours.timeZone).toBe("Asia/Yangon");
  });

  it("analytics resolves a legacy stored zone before it reaches SQL", async () => {
    const t = await org();
    await sql`insert into channel_settings (organization_id, channel, values) values (${t.id}, 'general', ${sql.json({ timeZone: "America/Buenos_Aires" })})`;
    const options = await m.analytics.getFilterOptions({ readModel: m.analyticsStore.drizzleAnalyticsReadModel } as never, t.actor);
    expect(options.timeZone).toBe("America/Argentina/Buenos_Aires");
    const report = await m.analytics.getAnalytics({ readModel: m.analyticsStore.drizzleAnalyticsReadModel }, t.actor, "timeseries", { from: "2026-10-01", to: "2026-10-03" });
    expect(report.scope.timeZone).toBe("America/Argentina/Buenos_Aires");
  });
});
