import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
/** Every store must write `encryption_version` = the envelope's first segment, or the envelope CHECK rejects the row. */
describeDb("credential stores write v2 envelopes", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  const orgs: string[] = [];
  let orgId = "";
  let userId = "";

  beforeAll(async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    [{ id: orgId }] = await sql`insert into organizations (name, slug) values ('S', ${"stores-" + tag}) returning id`;
    orgs.push(orgId);
    [{ id: userId }] = await sql`insert into users (name, email) values ('S', ${"stores-" + tag + "@example.test"}) returning id`;
  });
  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), [userId]);
    await sql.end();
  });

  const accountRow = async (key: string) =>
    (await sql`select c.encrypted_payload, c.encryption_version from integration_credentials c join integration_accounts a on a.id = c.account_id where a.organization_id = ${orgId} and a.key = ${key}`)[0];

  it("integrations store: create and replace", async () => {
    const { drizzleIntegrationStore } = await import("../drizzle-integration-store");
    const { credentialCipher } = await import("../credential-cipher");
    const account = { kind: "ai", key: "anthropic", name: "Anthropic" };
    await drizzleIntegrationStore.saveCredential(orgId, account, credentialCipher.encrypt('{"apiKey":"a"}'), { actorUserId: userId, verified: false });
    expect((await accountRow("anthropic")).encryption_version).toBe("v2");
    await drizzleIntegrationStore.saveCredential(orgId, account, credentialCipher.encrypt('{"apiKey":"b"}'), { actorUserId: userId, verified: false });
    const row = await accountRow("anthropic");
    expect(row.encryption_version).toBe("v2");
    expect(row.encrypted_payload.startsWith("v2:")).toBe(true);
  });

  it("linkedin account store: create and replace", async () => {
    const { drizzleLinkedInAccountStore } = await import("@/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-account-store");
    const creds = { dsn: "api1.unipile.com:13111", apiKey: "k", notifySecret: "s" };
    await drizzleLinkedInAccountStore.saveCredentials(orgId, creds);
    await drizzleLinkedInAccountStore.saveCredentials(orgId, { ...creds, apiKey: "k2" });
    const row = await accountRow("unipile");
    expect(row.encryption_version).toBe("v2");
    expect(await drizzleLinkedInAccountStore.getCredentials(orgId)).toMatchObject({ apiKey: "k2" });
  });

  it("grid provider store: create and replace pass the envelope CHECK", async () => {
    const { drizzleProviderStore } = await import("@/contexts/grid/enrichment/infrastructure/enrichment-provider-store");
    const { credentialCipher } = await import("../credential-cipher");
    const created = await drizzleProviderStore.create(orgId, { key: "hunter", name: "Hunter", baseUrl: null, defaultCostCents: 0, rateLimitPerMin: null, config: {} }, credentialCipher.encrypt('{"apiKey":"g1"}'));
    const read = () => accountRow("enrichment:hunter");
    expect((await read()).encryption_version).toBe("v2");
    await drizzleProviderStore.update(orgId, created.id, {}, credentialCipher.encrypt('{"apiKey":"g2"}'));
    const row = await read();
    expect(row.encryption_version).toBe("v2");
    expect(JSON.parse(credentialCipher.decrypt(row.encrypted_payload))).toEqual({ apiKey: "g2" });
    expect(await drizzleProviderStore.encryptedCredential(orgId, created.id)).toBe(row.encrypted_payload);
  });

  it("keeps a provider's account out of Settings, Integrations and takes it along on delete", async () => {
    const { drizzleProviderStore } = await import("@/contexts/grid/enrichment/infrastructure/enrichment-provider-store");
    const { drizzleIntegrationStore } = await import("../drizzle-integration-store");
    const { credentialCipher } = await import("../credential-cipher");
    const noKey = await drizzleProviderStore.create(orgId, { key: "apollo", name: "Apollo", baseUrl: null, defaultCostCents: 0, rateLimitPerMin: null, config: {} }, null);
    expect(noKey.hasCredential).toBe(false);
    expect(await drizzleProviderStore.encryptedCredential(orgId, noKey.id)).toBeNull();

    const added = await drizzleProviderStore.update(orgId, noKey.id, {}, credentialCipher.encrypt('{"apiKey":"late"}'));
    expect(added?.hasCredential).toBe(true);
    expect(JSON.stringify(added)).not.toMatch(/v2:|late|accountId/);
    const [{ account_id: accountId }] = await sql`select account_id from grid_providers where id = ${noKey.id}`;
    expect((await drizzleIntegrationStore.list(orgId)).map((a) => a.key)).not.toContain("enrichment:apollo");
    expect(await drizzleIntegrationStore.get(orgId, accountId)).toBeNull();

    expect(await drizzleProviderStore.delete(orgId, noKey.id)).toBe(true);
    expect(await accountRow("enrichment:apollo")).toBeUndefined();
    expect(await sql`select 1 from integration_accounts where id = ${accountId}`).toHaveLength(0);
    expect(await sql`select 1 from integration_credentials where account_id = ${accountId}`).toHaveLength(0);
  });

  it("rejects a provider pointing at another organization's account", async () => {
    const [{ id: otherOrg }] = await sql`insert into organizations (name, slug) values ('O', ${"stores-other-" + Math.random().toString(36).slice(2, 8)}) returning id`;
    orgs.push(otherOrg);
    const [{ id: account }] = await sql`insert into integration_accounts (organization_id, kind, key, name) values (${otherOrg}, 'enrichment', 'enrichment:x', 'x') returning id`;
    await expect(sql`insert into grid_providers (organization_id, key, name, account_id) values (${orgId}, 'x', 'x', ${account})`).rejects.toThrow(/foreign key/i);
  });
});
