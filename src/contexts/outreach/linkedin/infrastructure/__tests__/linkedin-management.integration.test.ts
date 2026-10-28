import { drizzleEnrollmentAdminStore } from "../../../infrastructure/drizzle-enrollment-admin";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { Actor } from "@/shared/errors";
import { ConflictError, ForbiddenError, ValidationError } from "@/shared/errors";
import { LinkedInGatewayError } from "../../application/linkedin-ports";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("linkedin connection and campaigns", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let mgmt: typeof import("../../application/linkedin-management");
  let campaignsUc: typeof import("../../application/linkedin-campaigns");
  let accountStore: typeof import("../drizzle-linkedin-account-store").drizzleLinkedInAccountStore;
  let connectStore: typeof import("../drizzle-linkedin-connect-store").drizzleLinkedInConnectStore;
  let auditSink: typeof import("@/contexts/tenancy/infrastructure/audit").auditSink;
  let campaignStore: typeof import("../drizzle-linkedin-campaign-store").drizzleLinkedInCampaignStore;
  const orgs: string[] = [];
  const users: string[] = [];

  async function org(appUrl = "https://app.example.com") {
    const tag = uniqueKey();
    const [{ id }] = await sql`insert into organizations (name, slug) values ('L', ${"lm-" + tag}) returning id`;
    const [{ id: userId }] = await sql`insert into users (name, email) values ('U', ${tag + "@lm.test"}) returning id`;
    orgs.push(id);
    users.push(userId);
    const gateway = new FakeLinkedInGateway();
    gateway.accounts = [{ ref: "u-" + tag, linkedinId: "ACo-" + tag, name: "Ada", username: "ada-" + tag, status: "connected" }];
    const deps: import("../../application/linkedin-management").LinkedInManagementDeps = { accounts: accountStore, gatewayFor: () => gateway, appUrl, now: () => new Date("2026-10-14T10:00:00Z"), audit: auditSink, connectLinks: connectStore };
    const actor: Actor = { userId, organizationId: id, role: "owner" };
    return { id, tag, gateway, deps, actor, member: { ...actor, role: "member" } as Actor, campaignDeps: { campaigns: campaignStore, admin: drizzleEnrollmentAdminStore } };
  }

  beforeAll(async () => {
    mgmt = await import("../../application/linkedin-management");
    campaignsUc = await import("../../application/linkedin-campaigns");
    ({ drizzleLinkedInAccountStore: accountStore } = await import("../drizzle-linkedin-account-store"));
    ({ drizzleLinkedInConnectStore: connectStore } = await import("../drizzle-linkedin-connect-store"));
    ({ auditSink } = await import("@/contexts/tenancy/infrastructure/audit"));
    ({ drizzleLinkedInCampaignStore: campaignStore } = await import("../drizzle-linkedin-campaign-store"));
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("normalizes the DSN", () => {
    expect(mgmt.normalizeDsn("https://API1.unipile.com:13111/")).toBe("api1.unipile.com:13111");
    expect(mgmt.normalizeDsn("api1.unipile.com")).toBe("api1.unipile.com");
    expect(mgmt.normalizeDsn("not a host")).toBeNull();
  });

  it("never sends the key to a host outside the allow-list and never echoes upstream text", async () => {
    const t = await org();
    for (const dsn of ["169.254.169.254", "10.0.0.5:5432", "attacker.com", "https://user@api1.unipile.com", "localhost:4000"]) {
      await expect(mgmt.connectLinkedIn(t.deps, t.actor, { dsn, apiKey: "k" })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(t.gateway.verifyCalls).toBe(0);
    expect(await accountStore.getCredentials(t.id)).toBeNull();

    t.gateway.verifyError = new LinkedInGatewayError("<html>secret internal page body</html>", "unknown", "unavailable");
    await expect(mgmt.connectLinkedIn(t.deps, t.actor, { dsn: "api1.unipile.com:13111", apiKey: "k" })).rejects.toThrow(/^Could not reach Unipile\. Check the DSN/);
    t.gateway.verifyError = new LinkedInGatewayError("<html>secret internal page body</html>", "definite", "rejected");
    await expect(mgmt.connectLinkedIn(t.deps, t.actor, { dsn: "api1.unipile.com:13111", apiKey: "k" })).rejects.not.toThrow(/secret internal/);
  });

  it("re-checks a stored DSN before syncing", async () => {
    const t = await org();
    await accountStore.saveCredentials(t.id, { dsn: "169.254.169.254", apiKey: "k", notifySecret: "s".repeat(24) });
    await expect(mgmt.syncLinkedInAccounts(t.deps, t.actor)).rejects.toBeInstanceOf(ConflictError);
    await expect(mgmt.registerLinkedInWebhooks(t.deps, t.actor)).rejects.toBeInstanceOf(ConflictError);
  });

  it("keeps syncing when an account id belongs to another organization or another LinkedIn account", async () => {
    const a = await org();
    const b = await org();
    await mgmt.connectLinkedIn(a.deps, a.actor, { dsn: "api1.unipile.com:13111", apiKey: "k" });
    const owned = a.gateway.accounts[0];
    // Org B's Unipile lists a colliding provider id first, then a healthy account.
    b.gateway.accounts = [
      { ref: owned.ref, linkedinId: "ACo-other-" + b.tag, name: "Eve", username: "eve-" + b.tag, status: "connected" },
      { ref: "ok-" + b.tag, linkedinId: "ACo-ok-" + b.tag, name: "Bob", username: "bob-" + b.tag, status: "connected" },
    ];
    const result = await mgmt.connectLinkedIn(b.deps, b.actor, { dsn: "api1.unipile.com:13111", apiKey: "k" });
    expect(result.accounts).toBe(2);
    expect(result.added).toBe(1);
    const synced = await mgmt.syncLinkedInAccounts(b.deps, b.actor);
    expect(synced).toMatchObject({ found: 2, added: 0, updated: 1, skipped: 1 });
    expect(synced.skippedReasons).toHaveLength(1);
    expect((await mgmt.listLinkedInAccounts(b.deps, b.actor)).accounts.map((x) => x.providerAccountId)).toEqual(["ok-" + b.tag]);

    // Same organization, same provider id, different LinkedIn identity: skipped too.
    a.gateway.accounts = [{ ...owned, linkedinId: "ACo-changed-" + a.tag, username: "changed-" + a.tag }];
    expect(await mgmt.syncLinkedInAccounts(a.deps, a.actor)).toMatchObject({ skipped: 1, added: 0 });
  });

  it("keeps one organization's webhook event from being dropped by another's", async () => {
    const [{ receiveLinkedInWebhook }, { createDrizzleLinkedInInboundStore }, { parseUnipilePayload }] = await Promise.all([
      import("../../application/linkedin-inbound"),
      import("../drizzle-linkedin-inbound-store"),
      import("../unipile-webhook"),
    ]);
    const a = await org();
    const b = await org();
    await mgmt.connectLinkedIn(a.deps, a.actor, { dsn: "api1.unipile.com:13111", apiKey: "k" });
    const account = a.gateway.accounts[0].ref;
    const deps = { store: createDrizzleLinkedInInboundStore((await import("@/composition/inbox-filing")).inboxFiling), clock: { now: () => new Date("2026-10-14T10:00:00Z") }, parse: parseUnipilePayload };
    const relation = { event: "new_relation", account_id: account, account_type: "LINKEDIN", user_provider_id: "ACoPoison" };
    const message = { event: "message_received", account_id: account, account_type: "LINKEDIN", account_info: { user_id: "ME" }, message_id: "m-" + a.tag, chat_id: "c1", message: "hi", sender: { attendee_provider_id: "ACoX" } };

    // Org B posts both payloads first, with its own valid secret.
    expect(await receiveLinkedInWebhook(deps, { organizationId: b.id, payload: relation })).toEqual({ status: "skipped" });
    expect(await receiveLinkedInWebhook(deps, { organizationId: b.id, payload: message })).toEqual({ status: "skipped" });
    // Org A's real events still go through.
    expect((await receiveLinkedInWebhook(deps, { organizationId: a.id, payload: relation })).status).not.toBe("duplicate");
    expect((await receiveLinkedInWebhook(deps, { organizationId: a.id, payload: message })).status).not.toBe("duplicate");
    // A true redelivery to the same organization is still deduplicated.
    expect(await receiveLinkedInWebhook(deps, { organizationId: a.id, payload: message })).toEqual({ status: "duplicate" });
    const rows = await sql`select organization_id, provider_event_key from inbound_events where organization_id in (${a.id}, ${b.id})`;
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => (r.provider_event_key as string).includes(":v2:" + r.organization_id))).toBe(true);
  });

  it("verifies, stores the key encrypted, syncs accounts and registers webhooks", async () => {
    const t = await org();
    await expect(mgmt.connectLinkedIn(t.deps, t.member, { dsn: "api1.unipile.com:13111", apiKey: "k" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(mgmt.connectLinkedIn(t.deps, t.actor, { dsn: "bad host", apiKey: "k" })).rejects.toBeInstanceOf(ValidationError);

    const result = await mgmt.connectLinkedIn(t.deps, t.actor, { dsn: "https://api1.unipile.com:13111/", apiKey: "super-secret-key" });
    expect(result).toMatchObject({ accounts: 1, added: 1, webhooks: { status: "registered" } });
    expect(t.gateway.webhookRegistrations[0].requestUrl).toBe(`https://app.example.com/api/webhooks/unipile?org=${t.id}`);

    const [stored] = await sql`select c.encrypted_payload from integration_credentials c join integration_accounts a on a.id = c.account_id where a.organization_id = ${t.id} and a.key = 'unipile'`;
    expect(stored.encrypted_payload).not.toContain("super-secret-key");
    const credentials = await accountStore.getCredentials(t.id);
    expect(credentials).toMatchObject({ dsn: "api1.unipile.com:13111", apiKey: "super-secret-key" });
    const secret = credentials?.notifySecret;
    expect(secret?.length).toBeGreaterThanOrEqual(24);

    // Reconnecting keeps the webhook secret and updates the account in place.
    await mgmt.connectLinkedIn(t.deps, t.actor, { dsn: "api1.unipile.com:13111", apiKey: "rotated" });
    expect((await accountStore.getCredentials(t.id))?.notifySecret).toBe(secret);
    const state = await mgmt.listLinkedInAccounts(t.deps, t.actor);
    expect(state.connected).toBe(true);
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]).toMatchObject({ status: "connected", dailyInviteLimit: 5, isPremium: false });
  });

  it("reports a rejected key and saves nothing", async () => {
    const t = await org();
    t.gateway.verifyError = new LinkedInGatewayError("Unipile: bad key", "definite", "auth");
    await expect(mgmt.connectLinkedIn(t.deps, t.actor, { dsn: "api1.unipile.com:13111", apiKey: "bad" })).rejects.toThrow(/rejected the API key/);
    expect(await accountStore.getCredentials(t.id)).toBeNull();
  });

  it("skips webhook registration for a local APP_URL and says why", async () => {
    const t = await org("http://localhost:3000");
    const result = await mgmt.connectLinkedIn(t.deps, t.actor, { dsn: "api1.unipile.com:13111", apiKey: "k" });
    expect(result.webhooks.status).toBe("skipped");
    expect(t.gateway.webhookRegistrations).toHaveLength(0);
  });

  it("returns the real registration result when saving the webhook status throws, and keeps the credentials", async () => {
    const failingStore = { ...accountStore, saveWebhookStatus: async () => { throw new Error("db down: super-secret-key"); } };
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.join(" ")));
    try {
      // Registration succeeds at the provider.
      const ok = await org();
      const okResult = await mgmt.connectLinkedIn({ ...ok.deps, accounts: failingStore }, ok.actor, { dsn: "api1.unipile.com:13111", apiKey: "super-secret-key" });
      expect(okResult).toMatchObject({ accounts: 1, added: 1, webhooks: { status: "registered" } });
      expect(ok.gateway.webhookRegistrations).toHaveLength(1);
      expect(await accountStore.getCredentials(ok.id)).toMatchObject({ apiKey: "super-secret-key" });

      // Registration fails at the provider and the second record throws as well.
      const bad = await org();
      bad.gateway.webhookError = new LinkedInGatewayError("<html>boom</html>", "unknown", "unavailable");
      const badResult = await mgmt.connectLinkedIn({ ...bad.deps, accounts: failingStore }, bad.actor, { dsn: "api1.unipile.com:13111", apiKey: "k" });
      expect(badResult.webhooks.status).toBe("failed");
      expect(badResult.webhooks.detail).toMatch(/Could not reach Unipile/);
      expect(await accountStore.getCredentials(bad.id)).not.toBeNull();

      // A local APP_URL still reports skipped.
      const local = await org("http://localhost:3000");
      const localResult = await mgmt.connectLinkedIn({ ...local.deps, accounts: failingStore }, local.actor, { dsn: "api1.unipile.com:13111", apiKey: "k" });
      expect(localResult.webhooks.status).toBe("skipped");

      expect(logged.some((l) => l.includes(ok.id))).toBe(true);
      expect(logged.join("\n")).not.toContain("super-secret-key");
    } finally {
      spy.mockRestore();
    }
  });

  it("updates account limits within bounds and disconnects", async () => {
    const t = await org();
    await mgmt.connectLinkedIn(t.deps, t.actor, { dsn: "api1.unipile.com:13111", apiKey: "k" });
    const [account] = (await mgmt.listLinkedInAccounts(t.deps, t.actor)).accounts;
    await expect(mgmt.updateLinkedInAccount(t.deps, t.actor, account.id, { dailyInviteLimit: 500 })).rejects.toBeInstanceOf(ValidationError);
    await mgmt.updateLinkedInAccount(t.deps, t.actor, account.id, { dailyInviteLimit: 12, isPremium: true });
    expect((await mgmt.listLinkedInAccounts(t.deps, t.actor)).accounts[0]).toMatchObject({ dailyInviteLimit: 12, isPremium: true });

    await mgmt.disconnectLinkedIn(t.deps, t.actor);
    const after = await mgmt.listLinkedInAccounts(t.deps, t.actor);
    expect(after.connected).toBe(false);
    expect(after.accounts[0].status).toBe("disconnected");
  });

  describe("webhook registration, reveal and disconnect", () => {
    const dsn = "api1.unipile.com:13111";
    const hookUrl = (id: string) => `https://app.example.com/api/webhooks/unipile?org=${id}`;

    it("stores the registration result without the secret and replaces it on the next registration", async () => {
      const t = await org();
      await mgmt.connectLinkedIn(t.deps, t.actor, { dsn, apiKey: "k-status" });
      const first = (await mgmt.listLinkedInAccounts(t.deps, t.actor)).webhooks;
      expect(first?.hooks).toEqual([
        { name: "users:new_relation", status: "registered" },
        { name: "messaging:message_received", status: "registered" },
      ]);
      expect(Number.isNaN(Date.parse(first?.at ?? ""))).toBe(false);

      t.gateway.failHook = "messaging:message_received";
      await mgmt.registerLinkedInWebhooks(t.deps, t.actor);
      const second = (await mgmt.listLinkedInAccounts(t.deps, t.actor)).webhooks;
      expect(second?.hooks.map((h) => h.status)).toEqual(["registered", "failed"]);
      expect(second?.hooks[1].error).toMatch(/Could not reach Unipile/);

      const credentials = await accountStore.getCredentials(t.id);
      const [row] = await sql`select config from integration_accounts where organization_id = ${t.id} and key = 'unipile'`;
      expect(JSON.stringify(row.config)).not.toContain(credentials?.notifySecret ?? "missing");
      expect(JSON.stringify(row.config)).not.toContain("k-status");
      // A fresh read through the store returns the stored value, and a reconnect keeps it until the next registration.
      expect((await accountStore.getWebhookStatus(t.id))?.hooks[1].status).toBe("failed");
    });

    it("names the registered and the failed hook when only one hook is created", async () => {
      const t = await org();
      t.gateway.failHook = "messaging:message_received";
      const result = await mgmt.connectLinkedIn(t.deps, t.actor, { dsn, apiKey: "k-partial" });
      expect(result.webhooks.status).toBe("failed");
      expect(result.webhooks.detail).toBe("Registered: users:new_relation. Failed: messaging:message_received - Could not reach Unipile. Check the DSN and try again.");
      expect((await mgmt.registerLinkedInWebhooks(t.deps, t.actor)).detail).toBe(result.webhooks.detail);
      expect(result.webhooks.detail).not.toContain("k-partial");

      // Both hooks refused: no registered list to print.
      const none = await org();
      none.gateway.webhookError = new LinkedInGatewayError("boom", "unknown", "unavailable");
      expect((await mgmt.connectLinkedIn(none.deps, none.actor, { dsn, apiKey: "k" })).webhooks.detail).toBe("Could not reach Unipile. Check the DSN and try again.");
    });

    it.each(["http://mia:3000", "http://100.88.1.2:3000"])("skips registration and makes no disconnect call for %s", async (appUrl) => {
      const t = await org(appUrl);
      const result = await mgmt.connectLinkedIn(t.deps, t.actor, { dsn, apiKey: "k" });
      expect(result.webhooks.status).toBe("skipped");
      expect(t.gateway.webhookRegistrations).toHaveLength(0);
      await mgmt.disconnectLinkedIn(t.deps, t.actor);
      expect(t.gateway.removeCalls).toBe(0);
      expect(await accountStore.getCredentials(t.id)).toBeNull();
    });

    it("stores a failed list call as failed hooks and a local URL as no hooks", async () => {
      const t = await org();
      t.gateway.webhookError = new LinkedInGatewayError("<html>boom</html>", "unknown", "unavailable");
      await mgmt.connectLinkedIn(t.deps, t.actor, { dsn, apiKey: "k" });
      const status = (await mgmt.listLinkedInAccounts(t.deps, t.actor)).webhooks;
      expect(status?.hooks.every((h) => h.status === "failed")).toBe(true);
      expect(JSON.stringify(status)).not.toContain("boom");

      const local = await org("http://localhost:3000");
      await mgmt.connectLinkedIn(local.deps, local.actor, { dsn, apiKey: "k" });
      expect((await mgmt.listLinkedInAccounts(local.deps, local.actor)).webhooks?.hooks).toEqual([]);
    });

    it("reveals the secret to an admin, writes one audit row without it, and refuses a member", async () => {
      const t = await org();
      await expect(mgmt.getLinkedInWebhookSetup(t.deps, t.actor)).rejects.toBeInstanceOf(ConflictError);
      await mgmt.connectLinkedIn(t.deps, t.actor, { dsn, apiKey: "k" });
      await expect(mgmt.getLinkedInWebhookSetup(t.deps, t.member)).rejects.toBeInstanceOf(ForbiddenError);
      const none = await sql`select 1 from audit_log where organization_id = ${t.id} and action = 'integration.secret_viewed'`;
      expect(none).toHaveLength(0);

      const secret = (await accountStore.getCredentials(t.id))?.notifySecret ?? "missing";
      const setup = await mgmt.getLinkedInWebhookSetup(t.deps, t.actor);
      expect(setup).toMatchObject({ headerName: "x-unipile-secret", secret, requestUrl: hookUrl(t.id) });
      expect(setup.webhooks.map((h) => h.name)).toEqual(["users:new_relation", "messaging:message_received"]);
      expect(setup.status?.hooks).toHaveLength(2);

      const rows = await sql`select actor_user_id, meta from audit_log where organization_id = ${t.id} and action = 'integration.secret_viewed'`;
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBe(t.actor.userId);
      expect(rows[0].meta).toEqual({ provider: "unipile" });
      // No other output carries the secret.
      expect(JSON.stringify(await mgmt.listLinkedInAccounts(t.deps, t.actor))).not.toContain(secret);
    });

    it("disconnect deletes only this organization's hooks, then clears credentials", async () => {
      const t = await org();
      await mgmt.connectLinkedIn(t.deps, t.actor, { dsn, apiKey: "k" });
      t.gateway.webhooks.push({ id: "other", requestUrl: "https://elsewhere.example.com/hook", secret: "s" });
      t.gateway.webhooks.push({ id: "other-org", requestUrl: hookUrl("00000000-0000-4000-8000-000000000000"), secret: "s" });
      expect(t.gateway.webhooks.filter((h) => h.requestUrl === hookUrl(t.id))).toHaveLength(2);

      await mgmt.disconnectLinkedIn(t.deps, t.actor);
      expect(t.gateway.webhooks.map((h) => h.id)).toEqual(["other", "other-org"]);
      expect(await accountStore.getCredentials(t.id)).toBeNull();
      expect((await mgmt.listLinkedInAccounts(t.deps, t.actor)).connected).toBe(false);
    });

    it("disconnect clears credentials when the gateway fails, and does not call it when nothing is connected", async () => {
      const t = await org();
      await mgmt.connectLinkedIn(t.deps, t.actor, { dsn, apiKey: "k" });
      t.gateway.webhookError = new LinkedInGatewayError("down", "unknown", "unavailable");
      await mgmt.disconnectLinkedIn(t.deps, t.actor);
      expect(await accountStore.getCredentials(t.id)).toBeNull();
      expect(t.gateway.removeCalls).toBe(1);

      const idle = await org();
      await mgmt.disconnectLinkedIn(idle.deps, idle.actor);
      expect(idle.gateway.removeCalls).toBe(0);
      await expect(mgmt.disconnectLinkedIn(idle.deps, idle.member)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it("creates, validates, starts and enrolls a LinkedIn campaign", async () => {
    const t = await org();
    const { id } = await campaignsUc.createLinkedInCampaign(t.campaignDeps, t.actor, { name: "Q4" });
    // The starter template carries a placeholder, and no account is connected yet.
    await expect(campaignsUc.changeLinkedInCampaignStatus(t.campaignDeps, t.actor, id, "active")).rejects.toThrow(/bracketed/);
    const campaign = await campaignsUc.getLinkedInCampaign(t.campaignDeps, t.actor, id);
    const steps = campaign.steps.map((s) => ({ ...s, body: s.body.replace(/\[\[[^\]]*\]\]/g, "we help") }));
    await expect(campaignsUc.updateLinkedInCampaign(t.campaignDeps, t.actor, id, { steps: [{ ...steps[0], kind: "message" }] })).rejects.toBeInstanceOf(ValidationError);
    await campaignsUc.updateLinkedInCampaign(t.campaignDeps, t.actor, id, { steps });
    await expect(campaignsUc.changeLinkedInCampaignStatus(t.campaignDeps, t.actor, id, "active")).rejects.toThrow(/Connect a LinkedIn account/);

    await mgmt.connectLinkedIn(t.deps, t.actor, { dsn: "api1.unipile.com:13111", apiKey: "k" });
    await campaignsUc.changeLinkedInCampaignStatus(t.campaignDeps, t.actor, id, "active");
    await expect(campaignsUc.updateLinkedInCampaign(t.campaignDeps, t.actor, id, { steps })).rejects.toBeInstanceOf(ConflictError);

    const add = async (slug: string | null, email: string | null) =>
      (await sql`insert into people (organization_id, linkedin_slug, email, first_name) values (${t.id}, ${slug}, ${email}, 'P') returning id`)[0].id as string;
    await add("ada-l", null);
    await add("bo-l", "bo@x.test");
    await add(null, "noprofile@x.test");
    const dnc = await add("cy-l", null);
    await sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${dnc}, ${t.id}, true, 'human', now())`;

    const first = await campaignsUc.enrollLinkedInLeads(t.campaignDeps, t.actor, id, {});
    expect(first).toEqual({ requested: 4, added: 2, alreadyEnrolled: 0, skippedDuplicate: 0, skippedMissingIdentity: 1, skippedNoProfile: 1, skippedSuppressed: 0, skippedDoNotContact: 1, skippedContact: 0 });
    const second = await campaignsUc.enrollLinkedInLeads(t.campaignDeps, t.actor, id, {});
    expect(second.added).toBe(0);
    expect(second.alreadyEnrolled).toBe(2);

    const rows = await sql`select e.status, e.channel, d.connection_state, d.profile_url from campaign_enrollments e join linkedin_enrollment_details d on d.enrollment_id = e.id where e.campaign_id = ${id} order by d.profile_url`;
    expect(rows.map((r) => [r.status, r.channel, r.connection_state, r.profile_url])).toEqual([
      ["pending", "linkedin", "none", "https://www.linkedin.com/in/ada-l"],
      ["pending", "linkedin", "none", "https://www.linkedin.com/in/bo-l"],
    ]);
    const list = await campaignsUc.listLinkedInCampaigns(t.campaignDeps, t.actor);
    expect(list[0]).toMatchObject({ id, enrolled: 2, invited: 0 });
  });

  it("shows the expected note length per lead from the lead's own fields and overrides", async () => {
    const t = await org();
    const { id } = await campaignsUc.createLinkedInCampaign(t.campaignDeps, t.actor, { name: "Notes" });
    const campaign = await campaignsUc.getLinkedInCampaign(t.campaignDeps, t.actor, id);
    const steps = campaign.steps.map((s, i) => (i === 0 ? { ...s, body: "Hi {{firstName}} at {{company}}. {{pitch}}" } : { ...s, body: s.body.replace(/\[\[[^\]]*\]\]/g, "ok") }));
    await campaignsUc.updateLinkedInCampaign(t.campaignDeps, t.actor, id, { steps });
    const [{ id: company }] = await sql`insert into companies (organization_id, name, domain) values (${t.id}, 'Acme', 'acme.test') returning id`;
    await sql`insert into people (organization_id, linkedin_slug, first_name, full_name, company_id) values (${t.id}, 'ada-n', 'Ada', 'Ada N', ${company})`;
    await sql`insert into people (organization_id, linkedin_slug, first_name, full_name) values (${t.id}, 'bo-n', null, 'Bo N')`;
    await campaignsUc.enrollLinkedInLeads(t.campaignDeps, t.actor, id, {});
    await sql`update campaign_enrollments set merge_fields = ${sql.json({ pitch: "x".repeat(300) })} where person_id = (select id from people where organization_id = ${t.id} and linkedin_slug = 'ada-n')`;
    const detail = await campaignsUc.getLinkedInCampaignDetail({ campaigns: campaignStore, admin: drizzleEnrollmentAdminStore }, t.actor, id, { tab: "all", search: "", page: 1, pageSize: 50 });
    const by = Object.fromEntries(detail.enrollments.rows.map((r) => [r.personName, r]));
    expect(by["Ada N"]).toMatchObject({ noteLength: "Hi Ada at Acme. ".length + 300, noteOverLimit: true });
    expect(by["Bo N"]).toMatchObject({ noteLength: "Hi at.".length, noteOverLimit: false });
  });

  it("keeps LinkedIn campaigns out of the email campaign list", async () => {
    const t = await org();
    await campaignsUc.createLinkedInCampaign(t.campaignDeps, t.actor, { name: "Only LinkedIn" });
    const { drizzleCampaignStore } = await import("../../../infrastructure/drizzle-management-stores");
    expect(await drizzleCampaignStore.list(t.id)).toEqual([]);
  });
  describe("campaign store setArchived", () => {
    const archivedAt = async (id: string) => (await sql`select archived_at from campaigns where id = ${id}`)[0].archived_at;

    it("archives only a completed campaign, in the same statement as the status check", async () => {
      const t = await org();
      const { id } = await campaignsUc.createLinkedInCampaign(t.campaignDeps, t.actor, { name: "Racing" });
      // A stale read that still shows `completed` must not archive a campaign that is a draft, active or paused now.
      for (const status of ["draft", "active", "paused"]) {
        await sql`update campaigns set status = ${status} where id = ${id}`;
        expect(await campaignStore.setArchived(t.id, id, true), status).toBe(false);
        expect(await archivedAt(id), status).toBeNull();
      }
      await sql`update campaigns set status = 'completed' where id = ${id}`;
      expect(await campaignStore.setArchived(t.id, id, true)).toBe(true);
      expect(await archivedAt(id)).not.toBeNull();
    });

    it("unarchives whatever the status is", async () => {
      const t = await org();
      const { id } = await campaignsUc.createLinkedInCampaign(t.campaignDeps, t.actor, { name: "Back" });
      await sql`update campaigns set status = 'paused', archived_at = now() where id = ${id}`;
      expect(await campaignStore.setArchived(t.id, id, false)).toBe(true);
      expect(await archivedAt(id)).toBeNull();
    });

    it("does not reach another organization's campaign or an email campaign", async () => {
      const a = await org();
      const b = await org();
      const { id } = await campaignsUc.createLinkedInCampaign(a.campaignDeps, a.actor, { name: "Theirs" });
      await sql`update campaigns set status = 'completed' where id = ${id}`;
      expect(await campaignStore.setArchived(b.id, id, true)).toBe(false);
      expect(await archivedAt(id)).toBeNull();
      await sql`update campaigns set channel = 'email' where id = ${id}`;
      expect(await campaignStore.setArchived(a.id, id, true)).toBe(false);
      expect(await archivedAt(id)).toBeNull();
    });
  });
});
