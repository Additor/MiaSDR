import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { Job } from "@/platform/jobs/types";
import { LinkedInGatewayError, type GatewayProfile } from "../../application/linkedin-ports";
import type { LinkedInManagementDeps } from "../../application/linkedin-management";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

// finishSlot throws for the organizations listed here, to prove one bad write does not stop the loop.
const slotFaults = vi.hoisted(() => ({ finishFails: new Set<string>() }));
vi.mock("@/platform/jobs/slots", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/jobs/slots")>();
  return {
    ...real,
    finishSlot: async (...args: Parameters<typeof real.finishSlot>) => {
      if (args[0].organizationId && slotFaults.finishFails.has(args[0].organizationId)) throw new Error("database is down");
      return real.finishSlot(...args);
    },
  };
});

const KEY_AUTH_TEXT = "Unipile rejected the saved key. Connect again with a new key.";

describeDb("linkedin.sync-accounts job", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  const orgs: string[] = [];
  const gateways = new Map<string, FakeLinkedInGateway>();
  let clock = new Date("2026-10-14T10:00:00Z");
  let accountStore: typeof import("../drizzle-linkedin-account-store").drizzleLinkedInAccountStore;
  let job: Job;
  let mgmtDeps: LinkedInManagementDeps;
  // Only organizations of this file take part, so rows other test files left behind never change a count.
  let only: string[] | null = null;
  const keyLog: string[] = [];
  const listLog: string[] = [];

  async function org(options: { credentials?: boolean; accounts?: FakeLinkedInGateway["accounts"] } = {}) {
    const tag = uniqueKey();
    const [{ id }] = await sql`insert into organizations (name, slug) values ('S', ${"ls-" + tag}) returning id`;
    orgs.push(id);
    const gateway = new FakeLinkedInGateway();
    gateway.accounts = options.accounts ?? [{ ref: "u-" + tag, linkedinId: "ACo-" + tag, name: "Ada", username: "ada-" + tag, status: "connected" }];
    const list = gateway.listAccounts.bind(gateway);
    gateway.listAccounts = async () => {
      listLog.push(tag);
      return list();
    };
    gateways.set("key-" + tag, gateway);
    if (options.credentials !== false) await accountStore.saveCredentials(id, { dsn: "api1.unipile.com:13111", apiKey: "key-" + tag, notifySecret: "s".repeat(32) });
    return { id, tag, gateway };
  }

  const run = (at: Date, deadline = Date.now() + 60_000, scope: string[] | null = null) => {
    clock = at;
    only = scope;
    return job.run({ deadline, now: () => at });
  };
  const at = (time: string) => new Date(`2026-10-14T${time}:00Z`);
  const accountsOf = (organizationId: string) => sql`select status, is_premium, daily_invite_limit from linkedin_accounts where organization_id = ${organizationId} order by created_at`;
  const slotsOf = (organizationId: string) => sql`select status, error from job_runs where job = 'linkedin-sync' and organization_id = ${organizationId} order by started_at`;
  const syncStatus = async (organizationId: string) => accountStore.getSyncStatus(organizationId);

  beforeAll(async () => {
    ({ drizzleLinkedInAccountStore: accountStore } = await import("../drizzle-linkedin-account-store"));
    const { drizzleLinkedInConnectStore } = await import("../drizzle-linkedin-connect-store");
    const { drizzleAuditSink } = await import("../drizzle-linkedin-operations-store");
    const { createLinkedInJobs } = await import("../../application/linkedin-jobs");
    mgmtDeps = {
      accounts: { ...accountStore, listCredentialedOrganizations: async () => (await accountStore.listCredentialedOrganizations()).filter((id) => (only ?? orgs).includes(id)) },
      // An unknown key means a credential reached the wrong place, so the double throws.
      gatewayFor: (credentials) => {
        keyLog.push(credentials.apiKey);
        const gateway = gateways.get(credentials.apiKey);
        if (!gateway) throw new Error("unknown key " + credentials.apiKey);
        return gateway;
      },
      appUrl: "https://app.example.com",
      now: () => clock,
      audit: drizzleAuditSink,
      connectLinks: drizzleLinkedInConnectStore,
    };
    const { claimSlot, finishSlot } = await import("@/platform/jobs/slots");
    job = createLinkedInJobs({} as never, {} as never, {} as never, mgmtDeps, { claim: claimSlot, finish: finishSlot }).find((j) => j.name === "linkedin.sync-accounts") as Job;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    await sql.end();
  });

  it("AC1: a status flip in the gateway changes the stored status, and flipping back reconnects", async () => {
    const o = await org();
    await run(at("10:00"));
    expect((await accountsOf(o.id)).map((r) => r.status)).toEqual(["connected"]);
    o.gateway.accounts = [{ ...o.gateway.accounts[0], status: "disconnected" }];
    await run(at("11:00"));
    expect((await accountsOf(o.id)).map((r) => r.status)).toEqual(["disconnected"]);
    o.gateway.accounts = [{ ...o.gateway.accounts[0], status: "connected" }];
    await run(at("12:00"));
    expect((await accountsOf(o.id)).map((r) => r.status)).toEqual(["connected"]);
  });

  it("AC1: the report counts the status changes", async () => {
    const o = await org();
    const first = await run(at("10:00"), undefined, [o.id]);
    expect(first.detail).toMatchObject({ added: 1, connected: 0, disconnected: 0 });
    o.gateway.accounts = [{ ...o.gateway.accounts[0], status: "disconnected" }];
    const second = await run(at("11:00"), undefined, [o.id]);
    expect(second.detail).toMatchObject({ added: 0, connected: 0, disconnected: 1 });
    expect(second).toMatchObject({ more: false });
    expect(Object.keys(second.detail ?? {}).sort()).toEqual(["added", "connected", "disconnected", "failed", "organizations"]);
  });

  it("AC2: a new account gets 30 invites when premium and 5 when not; a sync never changes an existing limit", async () => {
    const o = await org({
      accounts: [
        { ref: "p1", linkedinId: "ACo-p1", name: "Pro", username: "pro-1", status: "connected" },
        { ref: "f1", linkedinId: "ACo-f1", name: "Free", username: "free-1", status: "connected" },
      ],
    });
    const original = o.gateway.getOwnProfile.bind(o.gateway);
    o.gateway.getOwnProfile = async (account: string): Promise<GatewayProfile> => ({ ...(await original(account)), isPremium: account === "p1" });
    await run(at("10:00"));
    const limits = async () => Object.fromEntries((await sql`select provider_account_id as ref, daily_invite_limit as lim, is_premium as prem from linkedin_accounts where organization_id = ${o.id}`).map((r) => [r.ref, [r.lim, r.prem]]));
    expect(await limits()).toEqual({ p1: [30, true], f1: [5, false] });
    await sql`update linkedin_accounts set daily_invite_limit = 12 where organization_id = ${o.id} and provider_account_id = 'p1'`;
    o.gateway.getOwnProfile = async (account: string): Promise<GatewayProfile> => ({ ...(await original(account)), isPremium: account === "f1" });
    await run(at("11:00"));
    expect(await limits()).toEqual({ p1: [12, false], f1: [5, true] });
  });

  it("AC3: one run per organization per hour; the next hour runs again", async () => {
    const o = await org();
    await run(at("10:00"));
    expect(await slotsOf(o.id)).toHaveLength(1);
    o.gateway.accounts = [{ ...o.gateway.accounts[0], status: "disconnected" }];
    await run(at("10:30"));
    expect((await accountsOf(o.id)).map((r) => r.status)).toEqual(["connected"]);
    expect(await slotsOf(o.id)).toHaveLength(1);
    await run(at("11:00"));
    expect((await accountsOf(o.id)).map((r) => r.status)).toEqual(["disconnected"]);
    expect((await slotsOf(o.id)).length).toBe(2);
  });

  it("AC4: a failed sync reopens after 10 minutes and does not stop other organizations", async () => {
    const bad = await org();
    const good = await org();
    bad.gateway.readOutage = true;
    await run(at("10:00"));
    expect(await slotsOf(bad.id)).toMatchObject([{ status: "failed" }]);
    expect((await accountsOf(good.id)).map((r) => r.status)).toEqual(["connected"]);
    bad.gateway.readOutage = false;
    await run(at("10:09"));
    expect(await accountsOf(bad.id)).toHaveLength(0);
    await run(at("10:11"));
    expect((await accountsOf(bad.id)).map((r) => r.status)).toEqual(["connected"]);
    expect(await slotsOf(bad.id)).toMatchObject([{ status: "succeeded" }]);
  });

  it("AC5: organizations without credentials, with a disabled integration or with undecryptable credentials are skipped without error", async () => {
    const none = await org({ credentials: false });
    const disabled = await org();
    const broken = await org();
    await sql`update integration_accounts set enabled = false where organization_id = ${disabled.id}`;
    await sql`update integration_credentials set encrypted_payload = 'not-an-envelope' where account_id = (select id from integration_accounts where organization_id = ${broken.id})`;
    const result = await run(at("10:00"), undefined, [none.id, disabled.id, broken.id]);
    expect(result.detail).toMatchObject({ organizations: 0, failed: 0 });
    for (const o of [none, disabled, broken]) {
      expect(await slotsOf(o.id)).toHaveLength(0);
      expect(await accountsOf(o.id)).toHaveLength(0);
    }
  });

  it("AC6: a 401 leaves every account untouched and records the fixed text", async () => {
    const o = await org();
    await run(at("10:00"));
    expect(await syncStatus(o.id)).toEqual({ lastSyncAt: "2026-10-14T10:00:00.000Z", lastSyncError: null });
    o.gateway.accounts = [{ ...o.gateway.accounts[0], status: "disconnected" }];
    o.gateway.listAccounts = async () => {
      throw new LinkedInGatewayError("HTTP 401 from upstream-secret-host", "definite", "auth");
    };
    const result = await run(at("11:00"), undefined, [o.id]);
    expect(result.detail).toMatchObject({ organizations: 1, failed: 1, added: 0, connected: 0, disconnected: 0 });
    expect((await accountsOf(o.id)).map((r) => r.status)).toEqual(["connected"]);
    // The last success stays, the error is the fixed text and never the upstream message.
    expect(await syncStatus(o.id)).toEqual({ lastSyncAt: "2026-10-14T10:00:00.000Z", lastSyncError: KEY_AUTH_TEXT });
  });

  it("records lastSyncAt on success, shared with the manual Sync", async () => {
    const o = await org();
    expect(await syncStatus(o.id)).toEqual({ lastSyncAt: null, lastSyncError: null });
    const mgmt = await import("../../application/linkedin-management");
    clock = at("09:15");
    await mgmt.syncLinkedInAccounts(mgmtDeps, { userId: "00000000-0000-0000-0000-000000000000", organizationId: o.id, role: "owner" });
    expect(await syncStatus(o.id)).toEqual({ lastSyncAt: "2026-10-14T09:15:00.000Z", lastSyncError: null });
    o.gateway.readOutage = true;
    await expect(mgmt.syncLinkedInAccounts(mgmtDeps, { userId: "00000000-0000-0000-0000-000000000000", organizationId: o.id, role: "owner" })).rejects.toThrow();
    expect(await syncStatus(o.id)).toEqual({ lastSyncAt: "2026-10-14T09:15:00.000Z", lastSyncError: "Could not reach Unipile. Check the DSN and try again." });
  });

  it("AC7: tenant isolation, each organization's key reaches only its own gateway", async () => {
    const a = await org();
    const b = await org();
    keyLog.length = 0;
    listLog.length = 0;
    await run(at("10:00"), undefined, [a.id, b.id]);
    expect([...keyLog].sort()).toEqual(["key-" + a.tag, "key-" + b.tag].sort());
    expect([...listLog].sort()).toEqual([a.tag, b.tag].sort());
    const bBefore = await accountsOf(b.id);
    a.gateway.accounts = [{ ...a.gateway.accounts[0], status: "disconnected" }, { ref: "extra-" + a.tag, linkedinId: "ACo-extra-" + a.tag, name: "Extra", username: "extra-" + a.tag, status: "connected" }];
    await run(at("11:00"), undefined, [a.id, b.id]);
    expect(await accountsOf(a.id)).toHaveLength(2);
    expect(await accountsOf(b.id)).toEqual(bBefore);
    expect(await sql`select 1 from linkedin_accounts where organization_id = ${b.id} and provider_account_id like ${"extra-%"}`).toHaveLength(0);
  });

  it("AC7: an account whose LinkedIn id belongs to another organization is skipped with a reason and leaves that organization alone", async () => {
    const a = await org();
    const b = await org();
    await run(at("10:00"), undefined, [b.id]);
    const bRow = async () => sql`select provider_account_id, linkedin_id, name, status, organization_id from linkedin_accounts where organization_id = ${b.id}`;
    const before = await bRow();
    expect(before).toHaveLength(1);
    const stolen = { ref: "stolen-" + a.tag, linkedinId: before[0].linkedin_id as string, name: "Hijack", username: "hijack-" + a.tag, status: "disconnected" as const, isPremium: null, headline: null };
    const result = await accountStore.upsertAccounts(a.id, [stolen]);
    expect(result).toMatchObject({ added: 0, updated: 0, skipped: 1 });
    expect(result.skippedReasons[0]).toMatch(/another organization/);
    // The same listing through the job.
    a.gateway.accounts = [{ ref: stolen.ref, linkedinId: stolen.linkedinId, name: stolen.name, username: stolen.username, status: "disconnected" }];
    await run(at("11:00"), undefined, [a.id, b.id]);
    expect(await bRow()).toEqual(before);
    expect(await accountsOf(a.id)).toHaveLength(0);
  });

  it("a first sync that adds 3 connected accounts reports added 3 and no status change", async () => {
    const t = uniqueKey();
    const o = await org({ accounts: [1, 2, 3].map((n) => ({ ref: `n${n}-${t}`, linkedinId: `ACo-n${n}-${t}`, name: `N${n}`, username: `n-${n}-${t}`, status: "connected" as const })) });
    const result = await run(at("10:00"), undefined, [o.id]);
    expect(result.detail).toMatchObject({ organizations: 1, added: 3, connected: 0, disconnected: 0, failed: 0 });
  });

  it("a saved DSN the policy rejects records lastSyncError, fails the slot and does not stop the next organization", async () => {
    const bad = await org();
    const good = await org();
    await accountStore.saveCredentials(bad.id, { dsn: "evil.example.com:443", apiKey: "key-" + bad.tag, notifySecret: "s".repeat(32) });
    const result = await run(at("10:00"), undefined, [bad.id, good.id]);
    expect(result.detail).toMatchObject({ organizations: 2, failed: 1, added: 1 });
    expect(await syncStatus(bad.id)).toEqual({ lastSyncAt: null, lastSyncError: "The saved Unipile DSN is not allowed. Reconnect with the DSN from your Unipile dashboard." });
    expect(await slotsOf(bad.id)).toMatchObject([{ status: "failed" }]);
    expect((await accountsOf(good.id)).map((r) => r.status)).toEqual(["connected"]);
  });

  it("a finishSlot that throws does not skip the remaining organizations", async () => {
    const bad = await org();
    const good = await org();
    bad.gateway.readOutage = true;
    slotFaults.finishFails.add(bad.id);
    try {
      const result = await run(at("10:00"), undefined, [bad.id, good.id]);
      expect(result.detail).toMatchObject({ organizations: 2, failed: 1, added: 1 });
    } finally {
      slotFaults.finishFails.delete(bad.id);
    }
    expect((await accountsOf(good.id)).map((r) => r.status)).toEqual(["connected"]);
    expect(await slotsOf(good.id)).toMatchObject([{ status: "succeeded" }]);
  });

  it("AC8: a passed deadline claims nothing and reports more work", async () => {
    const o = await org();
    const result = await run(at("10:00"), Date.now() - 1);
    expect(result).toMatchObject({ processed: 0, more: true });
    expect(await slotsOf(o.id)).toHaveLength(0);
    expect(await accountsOf(o.id)).toHaveLength(0);
  });

  it("the registered jobs and the tick report list the job", async () => {
    const { registeredJobs } = await import("@/composition/job-registry");
    const names = registeredJobs().map((j) => j.name);
    expect(names.filter((n) => n.startsWith("linkedin."))).toEqual(["linkedin.sync-accounts", "linkedin.replay-events", "linkedin.reconcile", "linkedin.search", "linkedin.run"]);
    const { runTick } = await import("@/platform/jobs/tick");
    const report = await runTick([job], 10_000);
    expect(report.jobs.map((j) => j.name)).toEqual(["linkedin.sync-accounts"]);
    expect(report.jobs[0].error).toBeUndefined();
  });
});
