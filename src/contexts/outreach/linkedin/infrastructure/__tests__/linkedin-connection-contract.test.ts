import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@/shared/errors";
import * as connect from "../../application/linkedin-connect";
import * as mgmt from "../../application/linkedin-management";
import { LinkedInGatewayError, type GatewayErrorCode } from "../../application/linkedin-ports";
import { createUnipileVendor } from "../vendors/unipile/unipile-vendor";

/*
 * Pins what people and Unipile see from the connection flows: every sentence, URL and stored credential field.
 * These values are live contracts. Unipile stores the URLs, and existing installs store the credential JSON.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const LINK = "00000000-0000-4000-8000-000000000002";
const actor: Actor = { userId: "00000000-0000-4000-8000-000000000003", organizationId: ORG, role: "owner" };
const STORED = { dsn: "api1.unipile.com:13111", apiKey: "k", notifySecret: "notify-secret" };
const gatewayError = (code: GatewayErrorCode) => new LinkedInGatewayError("upstream text", "definite", code);

function world(options: { appUrl?: string; stored?: typeof STORED | null } = {}) {
  const gateway = {
    verify: vi.fn(async () => undefined),
    listAccounts: vi.fn(async () => []),
    registerWebhooks: vi.fn(async () => ({ registered: ["MiaSDR users", "MiaSDR messaging"], hooks: [{ name: "users:new_relation", error: null }, { name: "messaging:message_received", error: null }] as Array<{ name: string; error: unknown }> })),
    removeWebhooks: vi.fn(async () => ({ removed: 2 })),
    createConnectLink: vi.fn(async (input: unknown) => ({ url: "https://link.test", input })),
  };
  const accounts = {
    getCredentials: vi.fn(async () => (options.stored === undefined ? STORED : options.stored)),
    saveCredentials: vi.fn(async () => undefined),
    getWebhookStatus: vi.fn(async () => null),
    saveWebhookStatus: vi.fn(async () => undefined),
    getSyncStatus: vi.fn(async () => ({ lastSyncAt: null, lastSyncError: null })),
    saveSyncStatus: vi.fn(async () => undefined),
    clearCredentials: vi.fn(async () => undefined),
    upsertAccounts: vi.fn(async () => ({ added: 0, updated: 0, skipped: 0, skippedReasons: [], changes: [] })),
    list: vi.fn(async () => []),
  };
  const connectLinks = {
    expireDue: vi.fn(async () => undefined),
    countPending: vi.fn(async () => 0),
    create: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    noteError: vi.fn(async () => undefined),
    complete: vi.fn(async () => true),
    find: vi.fn(),
    listRecent: vi.fn(async () => []),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const deps = { accounts, vendor: createUnipileVendor({ gatewayFor: () => gateway as never }), appUrl: options.appUrl ?? "https://app.test/", now: () => new Date("2026-11-04T00:00:00Z"), audit, connectLinks } as unknown as mgmt.LinkedInManagementDeps;
  return { deps, gateway, accounts, connectLinks, audit };
}

const refusal = (run: () => Promise<unknown>) => run().then(() => null, (error: Error) => error.message);

describe("LinkedIn connection contract", () => {
  it("words a refused connection the same way", async () => {
    const f = world();
    const connectWith = (dsn: string, apiKey: string) => refusal(() => mgmt.connectLinkedIn(f.deps, actor, { dsn, apiKey }));
    expect(await connectWith("attacker.com", "k")).toBe("Enter the DSN as shown in the Unipile dashboard, for example api1.unipile.com:13111. Only Unipile hosts are accepted.");
    expect(await connectWith("api1.unipile.com:13111", "  ")).toBe("Enter the Unipile API key.");

    const verifyFails = async (error: unknown) => {
      f.gateway.verify.mockRejectedValueOnce(error);
      return connectWith("api1.unipile.com:13111", "k");
    };
    expect(await verifyFails(gatewayError("auth"))).toBe("Unipile rejected the API key. Check the key and the DSN in your Unipile dashboard.");
    expect(await verifyFails(gatewayError("unavailable"))).toBe("Could not reach Unipile. Check the DSN and try again.");
    expect(await verifyFails(gatewayError("insufficient_privileges"))).toBe("Unipile refused the request because this API key or LinkedIn account lacks access to it.");
    expect(await verifyFails(gatewayError("rejected"))).toBe("Unipile refused the request. Check the DSN and the API key.");
    expect(await verifyFails(new Error("socket"))).toBe("Could not reach Unipile.");
  });

  it("stores the credential fields existing installs already hold", async () => {
    const f = world({ stored: null });
    await mgmt.connectLinkedIn(f.deps, actor, { dsn: "https://API1.unipile.com:13111/", apiKey: " k " });
    const saved = (f.accounts.saveCredentials.mock.calls[0] as unknown[])[1] as Record<string, string>;
    expect(Object.keys(saved)).toEqual(["dsn", "apiKey", "notifySecret"]);
    expect(saved).toMatchObject({ dsn: "api1.unipile.com:13111", apiKey: "k" });
    expect(saved.notifySecret).toMatch(/^[\w-]{32}$/);

    const again = world();
    await mgmt.connectLinkedIn(again.deps, actor, { dsn: "api1.unipile.com:13111", apiKey: "new" });
    expect((again.accounts.saveCredentials.mock.calls[0] as unknown[])[1]).toEqual({ dsn: "api1.unipile.com:13111", apiKey: "new", notifySecret: "notify-secret" });
  });

  it("words a missing or unusable connection the same way", async () => {
    const none = world({ stored: null }).deps;
    for (const run of [() => mgmt.syncLinkedInAccounts(none, actor), () => mgmt.registerLinkedInWebhooks(none, actor), () => mgmt.getLinkedInWebhookSetup(none, actor), () => connect.createConnectLink(none, actor)]) {
      expect(await refusal(run)).toBe("Connect Unipile first.");
    }
    const loose = world({ stored: { ...STORED, dsn: "attacker.com" } }).deps;
    expect(await refusal(() => mgmt.syncLinkedInAccounts(loose, actor))).toBe("The saved Unipile DSN is not allowed. Reconnect with the DSN from your Unipile dashboard.");
  });

  it("records the same text for a failed sync", async () => {
    const texts = async (error: unknown) => {
      const f = world();
      f.gateway.listAccounts.mockRejectedValueOnce(error);
      await expect(mgmt.syncAndRecord(f.deps, ORG, f.gateway as never)).rejects.toBe(error);
      return (f.accounts.saveSyncStatus.mock.calls[0] as unknown[])[1];
    };
    expect(await texts(gatewayError("auth"))).toEqual({ lastSyncError: "Unipile rejected the saved key. Connect again with a new key." });
    expect(await texts(gatewayError("unavailable"))).toEqual({ lastSyncError: "Could not reach Unipile. Check the DSN and try again." });
  });

  it("keeps the webhook URL, header and hook list", async () => {
    const f = world();
    const setup = await mgmt.getLinkedInWebhookSetup(f.deps, actor);
    const requestUrl = `https://app.test/api/webhooks/unipile?org=${ORG}`;
    expect(setup).toEqual({
      requestUrl,
      headerName: "x-unipile-secret",
      secret: "notify-secret",
      webhooks: [
        { name: "users:new_relation", source: "users", event: "new_relation", requestUrl },
        { name: "messaging:message_received", source: "messaging", event: "message_received", requestUrl },
      ],
      status: null,
    });
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "integration.secret_viewed", meta: { provider: "unipile" } }));

    expect(await mgmt.registerLinkedInWebhooks(f.deps, actor)).toEqual({ status: "registered", detail: "Registered: MiaSDR users, MiaSDR messaging." });
    expect(f.gateway.registerWebhooks).toHaveBeenCalledWith({ requestUrl, secret: "notify-secret", name: "MiaSDR" });

    await mgmt.disconnectLinkedIn(f.deps, actor);
    expect(f.gateway.removeWebhooks).toHaveBeenCalledWith({ requestUrl });

    expect((await mgmt.listLinkedInAccounts(f.deps, actor))).toMatchObject({ connected: true, dsn: "api1.unipile.com:13111", webhookUrl: requestUrl });
    expect((await mgmt.listLinkedInAccounts(world({ stored: null }).deps, actor))).toMatchObject({ connected: false, dsn: null });
  });

  it("words webhook registration outcomes the same way", async () => {
    const local = world({ appUrl: "http://localhost:3000" });
    expect(await mgmt.registerLinkedInWebhooks(local.deps, actor)).toEqual({ status: "skipped", detail: "APP_URL is a local or private address, so Unipile cannot reach it. Replies and acceptances are not delivered until the app has a public HTTPS URL." });

    const partial = world();
    partial.gateway.registerWebhooks.mockResolvedValueOnce({ registered: ["MiaSDR users"], hooks: [{ name: "users:new_relation", error: null }, { name: "messaging:message_received", error: gatewayError("rejected") }] });
    expect(await mgmt.registerLinkedInWebhooks(partial.deps, actor)).toEqual({ status: "failed", detail: "Registered: MiaSDR users. Failed: messaging:message_received - Unipile refused the request. Check the DSN and the API key." });

    const down = world();
    down.gateway.registerWebhooks.mockRejectedValueOnce(gatewayError("unavailable"));
    await mgmt.registerLinkedInWebhooks(down.deps, actor);
    const text = "Could not reach Unipile. Check the DSN and try again.";
    expect((down.accounts.saveWebhookStatus.mock.calls[0] as unknown[])[1]).toMatchObject({ hooks: [{ name: "users:new_relation", status: "failed", error: text }, { name: "messaging:message_received", status: "failed", error: text }] });
  });

  it("keeps the connect link URLs Unipile calls and returns to", async () => {
    const f = world();
    const { linkId } = await connect.createConnectLink(f.deps, actor);
    const input = f.gateway.createConnectLink.mock.calls[0][0] as { successRedirectUrl: string; failureRedirectUrl: string; notifyUrl: string };
    expect(input.successRedirectUrl).toBe(`https://app.test/settings/linkedin?unipile=success&link=${linkId}`);
    expect(input.failureRedirectUrl).toBe(`https://app.test/settings/linkedin?unipile=failure&link=${linkId}`);
    expect(input.notifyUrl).toMatch(new RegExp(`^https://app\\.test/api/webhooks/unipile-account\\?link=${linkId}&secret=[\\w-]{32}$`));

    const refused = world();
    refused.gateway.createConnectLink.mockRejectedValueOnce(gatewayError("auth"));
    expect(await refusal(() => connect.createConnectLink(refused.deps, actor))).toBe("Unipile rejected the API key. Check the key and the DSN in your Unipile dashboard.");
  });

  describe("notify callback", () => {
    const SECRET = "s3cret";
    async function notify(payload: unknown, options: { stored?: typeof STORED | null; expiresAt?: Date; status?: string } = {}) {
      const f = world({ stored: options.stored });
      const { createHash } = await import("node:crypto");
      f.connectLinks.find.mockResolvedValue({ id: LINK, organizationId: ORG, providerName: "mia-x", secretHash: createHash("sha256").update(SECRET).digest("hex"), status: options.status ?? "pending", expiresAt: options.expiresAt ?? new Date("2026-11-04T00:10:00Z") });
      const result = await connect.receiveConnectNotify(f.deps, { linkId: LINK, secret: SECRET, payload });
      return { result, f };
    }

    it("accepts both success statuses and records the status Unipile sent", async () => {
      for (const status of ["CREATION_SUCCESS", "RECONNECTED"]) {
        const { result, f } = await notify({ status, account_id: "acc", name: "mia-x" });
        expect(result).toEqual({ status: 200, outcome: "completed" });
        expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "linkedin.account_connected", meta: { providerAccountId: "acc", status } }));
      }
    });

    it("answers bad bodies the same way", async () => {
      expect((await notify("nope")).result).toEqual({ status: 400 });
      expect((await notify({ status: "CREATION_SUCCESS", name: "mia-x" })).result).toEqual({ status: 400 });
      expect((await notify({ status: "CREATION_SUCCESS", account_id: "acc", name: "other" })).result).toEqual({ status: 401 });
    });

    it("words a failed link the same way", async () => {
      const failed = await notify({ status: "CREDENTIALS", name: "mia-x" });
      expect(failed.result).toEqual({ status: 200, outcome: "failed" });
      expect(failed.f.connectLinks.fail).toHaveBeenCalledWith(LINK, "Unipile reported CREDENTIALS.");

      const gone = await notify({ status: "CREATION_SUCCESS", account_id: "acc", name: "mia-x" }, { stored: null });
      expect(gone.f.connectLinks.fail).toHaveBeenCalledWith(LINK, "Unipile is no longer connected.");

      const late = await notify({ status: "CREATION_SUCCESS", account_id: "acc", name: "mia-x" }, { expiresAt: new Date("2026-11-03T00:00:00Z") });
      expect(late.result).toEqual({ status: 410 });
      expect(late.f.connectLinks.fail).toHaveBeenCalledWith(LINK, "The link expired before Unipile reported a result.");
    });
  });
});
