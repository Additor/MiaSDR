import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CredentialVerifier, VerifyResult } from "../../application/credential-verifier";
import type { Actor } from "@/shared/errors";
import { ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
const KEY = "c".repeat(40);

describeDb("integration credentials", () => {
  useTestEnv({ AI_PROVIDER: "fake" });
  const sql = testSql({ max: 3 });
  let uc: typeof import("../../application/integration-management");
  let store: typeof import("../drizzle-integration-store");
  let crypto: typeof import("../credential-crypto");
  const orgs: string[] = [];
  const users: string[] = [];
  const passing: CredentialVerifier = { verify: async () => ({ ok: true }) };
  const rejecting = (result: VerifyResult): CredentialVerifier => ({ verify: vi.fn(async () => result) });

  async function org(role = "owner") {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id }] = await sql`insert into organizations (name, slug) values ('I', ${"int-" + tag}) returning id`;
    orgs.push(id);
    const [{ id: userId }] = await sql`insert into users (name, email, email_verified) values ('I', ${`int-${tag}@test.local`}, true) returning id`;
    users.push(userId);
    const actor: Actor = { userId, organizationId: id, role };
    return { id, actor, member: { ...actor, role: "member" } as Actor };
  }
  const deps = (verifier: CredentialVerifier = passing) => ({ integrations: store.drizzleIntegrationStore, cipher: { encrypt: (p: string) => crypto.encryptCredential(p, KEY) }, verifier });
  const audit = (organizationId: string, action: string) => sql`select * from audit_log where organization_id = ${organizationId} and action = ${action} order by created_at`;

  beforeAll(async () => {
    // env() caches on first read, so the fake switch is set before any module loads.
    uc = await import("../../application/integration-management");
    store = await import("../drizzle-integration-store");
    crypto = await import("../credential-crypto");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("stores the key encrypted, lists metadata only, and rotates in place", async () => {
    const t = await org();
    const first = await uc.saveIntegrationCredential(deps(), t.actor, { providerKey: "anthropic", values: { apiKey: " sk-ant-one " } });
    expect(first.created).toBe(true);
    const [stored] = await sql`select encrypted_payload from integration_credentials where account_id = ${first.id}`;
    expect(stored.encrypted_payload).not.toContain("sk-ant-one");
    expect(JSON.parse(crypto.decryptCredential(stored.encrypted_payload, KEY))).toEqual({ apiKey: "sk-ant-one" });

    const second = await uc.saveIntegrationCredential(deps(), t.actor, { providerKey: "anthropic", values: { apiKey: "sk-ant-two" } });
    expect(second).toEqual({ id: first.id, created: false });
    const [rotated] = await sql`select encrypted_payload from integration_credentials where account_id = ${first.id}`;
    expect(JSON.parse(crypto.decryptCredential(rotated.encrypted_payload, KEY))).toEqual({ apiKey: "sk-ant-two" });

    const list = await uc.listIntegrations(deps(), t.actor);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "anthropic", kind: "ai", hasCredential: true, manageHref: null });
    expect(JSON.stringify(list)).not.toMatch(/sk-ant|encrypted|v1:/);
  });

  it("limits access to owners and admins and rejects unmanaged providers and empty keys", async () => {
    const t = await org();
    await expect(uc.listIntegrations(deps(), t.member)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.saveIntegrationCredential(deps(), t.member, { providerKey: "anthropic", values: { apiKey: "k" } })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.saveIntegrationCredential(deps(), { ...t.actor, role: "admin" }, { providerKey: "anthropic", values: { apiKey: "k" } })).resolves.toEqual({ id: expect.any(String), created: true });
    await expect(uc.saveIntegrationCredential(deps(), t.actor, { providerKey: "unipile", values: { apiKey: "k" } })).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.saveIntegrationCredential(deps(), t.actor, { providerKey: "anthropic", values: { apiKey: " " } })).rejects.toBeInstanceOf(ValidationError);
  });

  it("deletes the account and its credential, answers 404 across organizations, and leaves unipile alone", async () => {
    const a = await org();
    const b = await org();
    const { id } = await uc.saveIntegrationCredential(deps(), a.actor, { providerKey: "anthropic", values: { apiKey: "k" } });
    await expect(uc.deleteIntegration(deps(), b.actor, id)).rejects.toBeInstanceOf(NotFoundError);
    await uc.deleteIntegration(deps(), a.actor, id);
    expect(await sql`select 1 from integration_credentials where account_id = ${id}`).toHaveLength(0);
    await expect(uc.deleteIntegration(deps(), a.actor, id)).rejects.toBeInstanceOf(NotFoundError);

    const [{ id: unipile }] = await sql`insert into integration_accounts (organization_id, kind, key, name) values (${a.id}, 'platform', 'unipile', 'Unipile') returning id`;
    await expect(uc.deleteIntegration(deps(), a.actor, unipile)).rejects.toBeInstanceOf(ValidationError);
    const list = await uc.listIntegrations(deps(), a.actor);
    expect(list).toEqual([expect.objectContaining({ key: "unipile", hasCredential: false, manageHref: "/settings/linkedin" })]);
  });

  describe("verification", () => {
    it("stores nothing and writes no audit row when the provider rejects the key", async () => {
      const t = await org();
      for (const reason of ["rejected", "unreachable", "rate_limited", "unverifiable"] as const) {
        await expect(uc.saveIntegrationCredential(deps(rejecting({ ok: false, reason })), t.actor, { providerKey: "anthropic", values: { apiKey: "sk-ant-bad-key" } })).rejects.toMatchObject({
          constructor: ValidationError,
          message: expect.not.stringContaining("sk-ant-bad-key"),
        });
      }
      expect(await sql`select 1 from integration_accounts where organization_id = ${t.id}`).toHaveLength(0);
      expect(await sql`select 1 from audit_log where organization_id = ${t.id}`).toHaveLength(0);
    });

    it("keeps the stored key when a replacement is rejected", async () => {
      const t = await org();
      const first = await uc.saveIntegrationCredential(deps(), t.actor, { providerKey: "anthropic", values: { apiKey: "sk-ant-good" } });
      const [before] = await sql`select encrypted_payload from integration_credentials where account_id = ${first.id}`;
      await expect(uc.saveIntegrationCredential(deps(rejecting({ ok: false, reason: "rejected" })), t.actor, { providerKey: "anthropic", values: { apiKey: "sk-ant-typo" } })).rejects.toThrow("Anthropic rejected this API key.");
      const [after] = await sql`select encrypted_payload from integration_credentials where account_id = ${first.id}`;
      expect(after.encrypted_payload).toBe(before.encrypted_payload);
      expect(await audit(t.id, "integration.saved")).toHaveLength(1);
    });

    it("verifies before it encrypts or stores, and passes the trimmed values", async () => {
      const t = await org();
      const order: string[] = [];
      const verifier: CredentialVerifier = { verify: vi.fn(async (_key, values) => (order.push(`verify:${values.apiKey}`), { ok: true } as const)) };
      const base = deps(verifier);
      await uc.saveIntegrationCredential(
        {
          integrations: { ...base.integrations, saveCredential: (...args) => (order.push("store"), base.integrations.saveCredential(...args)) },
          cipher: { encrypt: (p) => (order.push("encrypt"), base.cipher.encrypt(p)) },
          verifier,
        },
        t.actor,
        { providerKey: "anthropic", values: { apiKey: "  sk-ant-order  " } },
      );
      expect(order).toEqual(["verify:sk-ant-order", "encrypt", "store"]);
    });

    it("does not verify for a member or an unmanaged provider", async () => {
      const t = await org();
      const verifier = rejecting({ ok: true });
      await expect(uc.saveIntegrationCredential(deps(verifier), t.member, { providerKey: "anthropic", values: { apiKey: "k" } })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(uc.saveIntegrationCredential(deps(verifier), t.actor, { providerKey: "unipile", values: { apiKey: "k" } })).rejects.toBeInstanceOf(ValidationError);
      expect(verifier.verify).not.toHaveBeenCalled();
    });

    it("builds a composition that makes no network call under AI_PROVIDER=fake", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const t = await org();
        await uc.saveIntegrationCredential((await import("../composition")).integrationDeps(), t.actor, { providerKey: "anthropic", values: { apiKey: "sk-ant-fake-mode" } });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe("audit", () => {
    const SECRET = "sk-ant-AUDIT-secret-4242";

    it("writes integration.saved once per save with created then rotated, and no secret", async () => {
      const t = await org();
      await uc.saveIntegrationCredential(deps(), t.actor, { providerKey: "anthropic", values: { apiKey: SECRET } });
      let rows = await audit(t.id, "integration.saved");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ organization_id: t.id, actor_user_id: t.actor.userId, entity_type: "integration_account", meta: { providerKey: "anthropic", change: "created" } });
      await uc.saveIntegrationCredential(deps(), t.actor, { providerKey: "anthropic", values: { apiKey: SECRET + "-2" } });
      rows = await audit(t.id, "integration.saved");
      expect(rows.map((r) => r.meta.change)).toEqual(["created", "rotated"]);
      const text = JSON.stringify(rows);
      // No window of the secret longer than 6 characters appears in any audit field.
      for (let i = 0; i + 6 <= SECRET.length; i++) expect(text).not.toContain(SECRET.slice(i, i + 6));
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("sk-ant");
    });

    it("records verified false when the check was skipped and true after a live check", async () => {
      const t = await org();
      const live: CredentialVerifier = { verify: async () => ({ ok: true, verified: true }) };
      const skipped: CredentialVerifier = { verify: async () => ({ ok: true, verified: false }) };
      await uc.saveIntegrationCredential(deps(live), t.actor, { providerKey: "anthropic", values: { apiKey: "sk-ant-live" } });
      await uc.saveIntegrationCredential(deps(skipped), t.actor, { providerKey: "anthropic", values: { apiKey: "sk-ant-skip" } });
      await uc.saveIntegrationCredential(deps(passing), t.actor, { providerKey: "anthropic", values: { apiKey: "sk-ant-plain" } });
      expect((await audit(t.id, "integration.saved")).map((r) => r.meta.verified)).toEqual([true, false, false]);
    });

    it("composition under AI_PROVIDER=fake records verified false", async () => {
      const t = await org();
      await uc.saveIntegrationCredential((await import("../composition")).integrationDeps(), t.actor, { providerKey: "anthropic", values: { apiKey: "sk-ant-fake-audit" } });
      expect((await audit(t.id, "integration.saved"))[0].meta).toMatchObject({ providerKey: "anthropic", verified: false });
    });

    it("writes integration.deleted once with actor and organization, and none for a 404", async () => {
      const t = await org();
      const { id } = await uc.saveIntegrationCredential(deps(), t.actor, { providerKey: "anthropic", values: { apiKey: SECRET } });
      await uc.deleteIntegration(deps(), t.actor, id);
      const rows = await audit(t.id, "integration.deleted");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ organization_id: t.id, actor_user_id: t.actor.userId, entity_id: id, meta: { providerKey: "anthropic" } });
      expect(JSON.stringify(rows)).not.toContain(SECRET);
      await expect(uc.deleteIntegration(deps(), t.actor, id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await audit(t.id, "integration.deleted")).toHaveLength(1);
    });

    it("rolls the audit row back with the credential when the transaction fails", async () => {
      const t = await org();
      const failing = { ...deps(), cipher: { encrypt: () => "v1:bad" } };
      // A payload the store accepts, then a failure after the audit insert: drop the credential table write by violating the audit FK.
      const ghost = { ...t.actor, userId: "11111111-1111-1111-1111-111111111111" };
      await expect(uc.saveIntegrationCredential(failing, ghost, { providerKey: "anthropic", values: { apiKey: "k" } })).rejects.toThrow();
      expect(await sql`select 1 from integration_accounts where organization_id = ${t.id}`).toHaveLength(0);
      expect(await sql`select 1 from integration_credentials c join integration_accounts a on a.id = c.account_id where a.organization_id = ${t.id}`).toHaveLength(0);
      expect(await audit(t.id, "integration.saved")).toHaveLength(0);
    });
  });
});
