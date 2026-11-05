import { describe, expect, it } from "vitest";
import { ValidationError } from "@/shared/errors";
import { LinkedInGatewayError } from "../../../../application/linkedin-ports";
import { LinkedApiPlainError } from "../linkedapi-errors";
import { createLinkedApiVendor } from "../linkedapi-vendor";

let tag = 0;
const CREATED = new Date("2026-11-05T10:00:00Z");

function vendorWith(session: unknown, accounts: unknown[] = []) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    const path = String(url).replace("https://api.linkedapi.io/admin/", "");
    calls.push(path);
    if (path === "accounts.getConnectionSession") return new Response(JSON.stringify({ success: true, result: { session } }));
    if (path === "accounts.getAll") return new Response(JSON.stringify({ success: true, result: { accounts } }));
    return new Response(JSON.stringify({ success: true, result: {} }));
  }) as unknown as typeof fetch;
  tag += 1;
  const vendor = createLinkedApiVendor({ fetch: fetcher });
  return { vendor, calls, credentials: { apiKey: `vendor-${tag}` } };
}

const status = (made: ReturnType<typeof vendorWith>) => made.vendor.connectSession!.status(made.credentials, { ref: "s1", createdAt: CREATED, reconnectAccount: null, knownAccounts: ["known"] });

describe("the Linked API vendor", () => {
  it("reads the token it was given, and only one link at a time", () => {
    const { vendor } = vendorWith({});
    expect(vendor.readConnectInput({ apiKey: "  linked_abc  " })).toEqual({ apiKey: "linked_abc" });
    expect(() => vendor.readConnectInput({ apiKey: " " })).toThrow(ValidationError);
    expect(vendor.connectSession?.oneLinkAtATime).toBe(true);
    expect(vendor.syncAddsAccounts).toBe(true);
    expect(vendor.connectCallback).toBeNull();
  });

  it.each(["preparing", "pending", "serving", "streaming", "a status added later"])("waits while a session is %s", async (state) => {
    expect(await status(vendorWith({ status: state }))).toEqual({ state: "pending" });
  });

  it.each(["expired", "cancelled", "error"])("ends a session that says %s, with a sentence", async (state) => {
    expect(await status(vendorWith({ status: state }))).toMatchObject({ state: "failed", error: expect.stringContaining("Make a new link") });
  });

  it("names the newest active sign-in since the link", async () => {
    const accounts = [
      { id: "older", url: "https://www.linkedin.com/in/a", status: "active", connectedAt: "2026-11-01T00:00:00Z" },
      { id: "first", url: "https://www.linkedin.com/in/b", status: "active", connectedAt: "2026-11-05T10:01:00Z" },
      { id: "second", url: "https://www.linkedin.com/in/c", status: "active", connectedAt: "2026-11-05T10:05:00Z" },
      { id: "inactive", url: "https://www.linkedin.com/in/d", status: "reconnection_required", connectedAt: "2026-11-05T10:09:00Z" },
    ];
    expect(await status(vendorWith({ status: "success" }, accounts))).toEqual({ state: "connected", account: "second" });
  });

  it("does not take an account this organization holds already for the new sign-in", async () => {
    const accounts = [{ id: "known", url: "https://www.linkedin.com/in/a", status: "active", connectedAt: "2026-11-05T10:01:00Z" }];
    expect(await status(vendorWith({ status: "success" }, accounts))).toEqual({ state: "pending" });
  });

  it("finds a reconnected account by its profile, whatever its id and sign-in time", async () => {
    const made = vendorWith({ status: "success" }, [
      { id: "other", url: "https://www.linkedin.com/in/b", status: "active", connectedAt: "2026-11-05T10:09:00Z" },
      { id: "kept", url: "https://www.linkedin.com/in/ada", status: "active", connectedAt: "2026-10-01T00:00:00Z" },
    ]);
    expect(await made.vendor.connectSession!.status(made.credentials, { ref: "s1", createdAt: CREATED, reconnectAccount: { ref: "kept", username: "ada" }, knownAccounts: ["kept"] })).toEqual({ state: "connected", account: "kept" });
  });

  it("names another profile on a reconnect, so the link can say someone else signed in", async () => {
    const made = vendorWith({ status: "success" }, [{ id: "other", url: "https://www.linkedin.com/in/b", status: "active", connectedAt: "2026-11-05T10:09:00Z" }]);
    expect(await made.vendor.connectSession!.status(made.credentials, { ref: "s1", createdAt: CREATED, reconnectAccount: { ref: "old", username: "ada" }, knownAccounts: ["old"] })).toEqual({ state: "connected", account: "other" });
  });

  it("keeps waiting while the account is still being created", async () => {
    expect(await status(vendorWith({ status: "success" }, [{ id: "older", url: "https://www.linkedin.com/in/a", status: "active", connectedAt: "2026-11-01T00:00:00Z" }]))).toEqual({ state: "pending" });
  });

  it("cancels the session, and gives no account an id it does not hold", async () => {
    const made = vendorWith({});
    await made.vendor.connectSession!.cancel(made.credentials, "s1");
    expect(made.calls).toEqual(["accounts.cancelConnectionSession"]);
  });

  it("explains with its own words, and never the upstream text", () => {
    const { vendor } = vendorWith({});
    expect(vendor.explain(new LinkedInGatewayError("upstream words", "definite", "auth"))).toContain("rejected the token");
    expect(vendor.explain(new LinkedInGatewayError("upstream words", "unknown", "unavailable"))).toBe("Could not reach Linked API. Try again.");
    expect(vendor.explain(new LinkedApiPlainError("Renew it.", "definite", "rejected"))).toBe("Renew it.");
    expect(vendor.explainSyncFailure(new LinkedInGatewayError("upstream words", "definite", "auth"))).toContain("saved token");
  });
});
