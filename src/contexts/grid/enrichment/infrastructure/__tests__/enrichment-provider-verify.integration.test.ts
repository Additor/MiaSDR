import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { CredentialVerifier, VerifyResult } from "@/platform/credentials/verify";
import { ValidationError } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { gridOrg } from "../../../infrastructure/__tests__/grid-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. The verifier is a stub, no network. */
const KEY = "hunter-SECRET-key-98765";

describeDb("grid provider key verification", () => {
  const sql = testSql({ max: 3 });
  const orgs: TestOrg[] = [];
  let m: {
    providers: typeof import("../../application/enrichment-providers");
    adapters: typeof import("../enrichment-adapters");
    pstore: typeof import("../enrichment-provider-store");
  };

  const verifier = (result: VerifyResult) => ({ verify: vi.fn(async () => result) }) satisfies CredentialVerifier;
  const deps = (v?: CredentialVerifier) => {
    const urlPolicy = { allowedHosts: [] as string[] };
    return {
      providers: m.pstore.drizzleProviderStore,
      // A stub envelope keeps this test independent of the crypto format. It only needs a distinct value per plaintext.
      cipher: { encrypt: (p: string) => `v1:${Buffer.from(p).toString("base64url")}`, decrypt: (e: string) => Buffer.from(e.slice(3), "base64url").toString() },
      adapters: m.adapters.createAdapterRegistry({ policy: urlPolicy, net: {}, fake: new m.adapters.FakeEnrichmentProvider() }),
      urlPolicy,
      allowFake: true,
      verifier: v,
    };
  };
  async function org(role = "owner") {
    const { organizationId: id, actor } = await gridOrg(sql, orgs, role, "V");
    return { id, actor };
  }
  const count = async (id: string) => (await sql`select 1 from grid_providers where organization_id = ${id}`).length;

  useTestEnv();

  beforeAll(async () => {
    m = {
      providers: await import("../../application/enrichment-providers"),
      adapters: await import("../enrichment-adapters"),
      pstore: await import("../enrichment-provider-store"),
    };
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("stores no provider when the vendor rejects the key, and the message has no key", async () => {
    const t = await org();
    const v = verifier({ ok: false, reason: "rejected" });
    const error = await m.providers.createProvider(deps(v), t.actor, { adapter: "hunter", credentials: { apiKey: KEY } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe("Hunter rejected this API key.");
    expect((error as Error).message).not.toContain(KEY);
    expect(v.verify).toHaveBeenCalledWith("hunter", { apiKey: KEY });
    expect(await count(t.id)).toBe(0);
  });

  it("stores the provider when the key verifies and keeps the old key when a replacement fails", async () => {
    const t = await org();
    const created = await m.providers.createProvider(deps(verifier({ ok: true })), t.actor, { adapter: "hunter", credentials: { apiKey: KEY } });
    expect(created.hasCredential).toBe(true);
    const [before] = await sql`select encrypted_payload from grid_provider_credentials where provider_id = ${created.id}`;
    await expect(m.providers.updateProvider(deps(verifier({ ok: false, reason: "unreachable" })), t.actor, created.id, { credentials: { apiKey: "typo" } })).rejects.toThrow("Hunter could not be reached. Check your connection and try again.");
    const [after] = await sql`select encrypted_payload from grid_provider_credentials where provider_id = ${created.id}`;
    expect(after.encrypted_payload).toBe(before.encrypted_payload);
    await m.providers.updateProvider(deps(verifier({ ok: true })), t.actor, created.id, { credentials: { apiKey: "good-two" } });
    const [rotated] = await sql`select encrypted_payload from grid_provider_credentials where provider_id = ${created.id}`;
    expect(rotated.encrypted_payload).not.toBe(before.encrypted_payload);
  });

  it("asks the verifier by adapter and skips it when no credential is sent", async () => {
    const t = await org();
    const v = verifier({ ok: false, reason: "rejected" });
    await m.providers.createProvider(deps(v), t.actor, { adapter: "fake", key: "fake", name: "fake" });
    expect(v.verify).not.toHaveBeenCalled();
    await m.providers.createProvider(deps(v), t.actor, { adapter: "fake", key: "fake2", name: "fake2", credentials: { apiKey: KEY } }).catch(() => undefined);
    expect(v.verify).toHaveBeenCalledWith("fake", { apiKey: KEY });
  });

  it("verifies an Apollo key before saving it and stores the fixed host", async () => {
    const t = await org();
    const rejecting = verifier({ ok: false, reason: "rejected" });
    await expect(m.providers.createProvider(deps(rejecting), t.actor, { adapter: "apollo", credentials: { apiKey: KEY } })).rejects.toThrow("Apollo rejected this API key.");
    expect(rejecting.verify).toHaveBeenCalledWith("apollo", { apiKey: KEY });
    expect(await count(t.id)).toBe(0);
    const created = await m.providers.createProvider(deps(verifier({ ok: true })), t.actor, { adapter: "apollo", credentials: { apiKey: KEY } });
    expect(created).toMatchObject({ key: "apollo", adapter: "apollo", baseUrl: "https://api.apollo.io", hasCredential: true });
    expect(created.actions.map((a) => a.key)).toEqual(["enrich-person", "enrich-company"]);
  });

  it("starts a vendor with its published rate limit unless the admin sets one", async () => {
    const t = await org();
    const ok = verifier({ ok: true });
    const prospeo = await m.providers.createProvider(deps(ok), t.actor, { adapter: "prospeo", credentials: { apiKey: KEY } });
    expect(prospeo).toMatchObject({ baseUrl: "https://api.prospeo.io", rateLimitPerMin: 300 });
    const own = await m.providers.createProvider(deps(ok), t.actor, { adapter: "leadmagic", rateLimitPerMin: 50, credentials: { apiKey: KEY } });
    expect(own.rateLimitPerMin).toBe(50);
    const unlimited = await m.providers.createProvider(deps(ok), t.actor, { adapter: "zerobounce", credentials: { apiKey: KEY } });
    expect(unlimited.rateLimitPerMin).toBeNull();
  });

  it("does not verify for a member", async () => {
    const t = await org("member");
    const v = verifier({ ok: true });
    await expect(m.providers.createProvider(deps(v), t.actor, { adapter: "hunter", credentials: { apiKey: KEY } })).rejects.toThrow(/owner or admin/);
    expect(v.verify).not.toHaveBeenCalled();
  });
});
