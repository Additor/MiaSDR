import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { rotateCredentials } from "../../../../../scripts/rotate-credentials.mjs";
import { credentialKeyId, decryptCredential, encryptCredential, encryptCredentialV1 } from "../credential-crypto";
import { describeDb, dropOrgs, TEST_DATABASE_URL, testSql } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
const NEW = "n".repeat(40);
const OLD = "o".repeat(40);
const LOST = "l".repeat(40);

describeDb("credentials:rotate", () => {
  const sql = testSql({ max: 3 });
  const orgs: string[] = [];

  /** Every run scans both whole tables, so each test starts from empty tables of its own organization's rows. */
  async function seed() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id: orgId }] = await sql`insert into organizations (name, slug) values ('R', ${"rot-" + tag}) returning id`;
    orgs.push(orgId);
    const account = async (key: string, envelope: string, version: string) => {
      const [{ id }] = await sql`insert into integration_accounts (organization_id, key, name, kind) values (${orgId}, ${key}, ${key}, 'ai') returning id`;
      await sql`insert into integration_credentials (account_id, encrypted_payload, encryption_version) values (${id}, ${envelope}, ${version})`;
      return id as string;
    };
    const provider = async (key: string, envelope: string, version: string) => {
      const [{ id }] = await sql`insert into grid_providers (organization_id, key, name) values (${orgId}, ${key}, ${key}) returning id`;
      await sql`insert into grid_provider_credentials (provider_id, organization_id, encrypted_payload, encryption_version) values (${id}, ${orgId}, ${envelope}, ${version})`;
      return id as string;
    };
    return { account, provider };
  }
  const payload = async (table: string, pk: string, id: string): Promise<{ encrypted_payload: string; encryption_version: string }> =>
    (await sql.unsafe(`select encrypted_payload, encryption_version from ${table} where ${pk} = $1`, [id]))[0] as never;
  const run = (apply: boolean) => rotateCredentials({ sql, currentKey: NEW, legacyKeys: [OLD], apply });

  beforeAll(async () => {
    await sql`delete from grid_provider_credentials`;
    await sql`delete from integration_credentials`;
  });
  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    await sql.end();
  });

  it("dry run counts rows and changes nothing", async () => {
    const s = await seed();
    const a = await s.account("anthropic", encryptCredentialV1("A", OLD), "v1");
    const g = await s.provider("hunter", encryptCredential("G", OLD), "v2");
    const before = [await payload("integration_credentials", "account_id", a), await payload("grid_provider_credentials", "provider_id", g)];
    const report = await run(false);
    expect(report.apply).toBe(false);
    expect(report.tables.integration_credentials).toMatchObject({ total: 1, current: 0, rotated: 1, undecryptable: [] });
    expect(report.tables.grid_provider_credentials).toMatchObject({ total: 1, rotated: 1 });
    expect(report.tables.integration_credentials.bySourceKey).toEqual({ [credentialKeyId(OLD)]: 1 });
    expect([await payload("integration_credentials", "account_id", a), await payload("grid_provider_credentials", "provider_id", g)]).toEqual(before);
    await sql`delete from organizations where id = (select organization_id from integration_accounts where id = ${a})`;
  });

  it("apply re-encrypts, rows decrypt with the new key alone, and a second run changes nothing", async () => {
    const s = await seed();
    const a = await s.account("anthropic", encryptCredentialV1('{"apiKey":"one"}', OLD), "v1");
    const g = await s.provider("hunter", encryptCredential('{"apiKey":"two"}', OLD), "v2");
    const report = await run(true);
    expect(report.tables.integration_credentials.rotated).toBe(1);
    expect(report.tables.grid_provider_credentials.rotated).toBe(1);
    const rowA = await payload("integration_credentials", "account_id", a);
    const rowG = await payload("grid_provider_credentials", "provider_id", g);
    expect(decryptCredential(rowA.encrypted_payload, NEW)).toBe('{"apiKey":"one"}');
    expect(decryptCredential(rowG.encrypted_payload, NEW)).toBe('{"apiKey":"two"}');
    expect(rowA.encrypted_payload.startsWith(`v2:${credentialKeyId(NEW)}:`)).toBe(true);
    expect([rowA.encryption_version, rowG.encryption_version]).toEqual(["v2", "v2"]);

    const again = await run(true);
    expect(again.tables.integration_credentials).toMatchObject({ total: 1, current: 1, rotated: 0 });
    expect(again.tables.grid_provider_credentials).toMatchObject({ total: 1, current: 1, rotated: 0 });
    expect(await payload("integration_credentials", "account_id", a)).toEqual(rowA);
    expect(await payload("grid_provider_credentials", "provider_id", g)).toEqual(rowG);
  });

  it("lists an undecryptable row, leaves it untouched and rotates the others", async () => {
    const s = await seed();
    const bad = await s.account("anthropic", encryptCredential("lost", LOST), "v2");
    const good = await s.provider("hunter", encryptCredentialV1("kept", OLD), "v1");
    const badBefore = await payload("integration_credentials", "account_id", bad);
    const report = await run(true);
    expect(report.tables.integration_credentials.undecryptable).toEqual([{ id: bad, reason: `no known key for key id ${credentialKeyId(LOST)}` }]);
    expect(JSON.stringify(report)).not.toContain(LOST);
    expect(await payload("integration_credentials", "account_id", bad)).toEqual(badBefore);
    const row = await payload("grid_provider_credentials", "provider_id", good);
    expect(decryptCredential(row.encrypted_payload, NEW)).toBe("kept");
  });

  it("opens rows on the current key too: a truncated payload and a tampered tag are undecryptable and untouched", async () => {
    await sql`delete from grid_provider_credentials`;
    await sql`delete from integration_credentials`;
    const s = await seed();
    const good = encryptCredential("fine", NEW);
    const [v, id, iv, tag, body] = encryptCredential("tampered", NEW).split(":");
    const flipped = (tag[0] === "A" ? "B" : "A") + tag.slice(1);
    const truncated = encryptCredential("truncated", NEW).slice(0, -6);
    const a = await s.account("anthropic", [v, id, iv, flipped, body].join(":"), "v2");
    const b = await s.provider("hunter", truncated, "v2");
    const c = await s.provider("apollo", good, "v2");
    const before = [await payload("integration_credentials", "account_id", a), await payload("grid_provider_credentials", "provider_id", b), await payload("grid_provider_credentials", "provider_id", c)];
    for (const apply of [false, true]) {
      const report = await run(apply);
      expect(report.tables.integration_credentials.undecryptable.map((u: { id: string }) => u.id)).toEqual([a]);
      expect(report.tables.grid_provider_credentials.undecryptable.map((u: { id: string }) => u.id)).toEqual([b]);
      expect(report.tables.integration_credentials).toMatchObject({ total: 1, current: 0, rotated: 0 });
      expect(report.tables.grid_provider_credentials).toMatchObject({ total: 2, current: 1, rotated: 0 });
      expect(JSON.stringify(report)).not.toContain(NEW);
      expect([await payload("integration_credentials", "account_id", a), await payload("grid_provider_credentials", "provider_id", b), await payload("grid_provider_credentials", "provider_id", c)]).toEqual(before);
    }
  });

  it("runs under plain node: dry run by default, --apply writes, output holds no key", async () => {
    await sql`delete from grid_provider_credentials`;
    await sql`delete from integration_credentials`;
    const s = await seed();
    const a = await s.account("anthropic", encryptCredentialV1("node-run", OLD), "v1");
    const env = { PATH: process.env.PATH, DATABASE_URL: TEST_DATABASE_URL, DATABASE_SSL: "disable", INTEGRATION_CREDENTIALS_KEY: NEW, INTEGRATION_CREDENTIALS_LEGACY_KEYS: OLD };
    const node = (...args: string[]) => promisify(execFile)(process.execPath, ["scripts/rotate-credentials.mjs", ...args], { env: { ...env, NODE_ENV: "test" } as NodeJS.ProcessEnv, cwd: process.cwd() });

    const dry = await node();
    expect(dry.stdout).toContain("Dry run");
    expect(dry.stdout).toContain(`Current key id: ${credentialKeyId(NEW)}`);
    expect((await payload("integration_credentials", "account_id", a)).encryption_version).toBe("v1");

    const applied = await node("--apply");
    expect(applied.stdout).toContain("integration_credentials: 1 rows, 0 already on the current key, 1 rotated");
    expect(applied.stdout + applied.stderr).not.toMatch(new RegExp(`${NEW}|${OLD}|node-run`));
    expect(decryptCredential((await payload("integration_credentials", "account_id", a)).encrypted_payload, NEW)).toBe("node-run");

    await expect(node("--bogus")).rejects.toMatchObject({ code: 1 });
    await sql`insert into integration_accounts (organization_id, key, name, kind) select organization_id, 'other', 'other', 'ai' from integration_accounts where id = ${a}`;
    const [{ id: lostId }] = await sql`select id from integration_accounts where key = 'other' order by created_at desc limit 1`;
    await sql`insert into integration_credentials (account_id, encrypted_payload, encryption_version) values (${lostId}, ${encryptCredential("x", LOST)}, 'v2')`;
    await expect(node("--apply")).rejects.toMatchObject({ code: 2 });
    await sql`delete from integration_credentials where account_id = ${lostId}`;
    await sql`update integration_credentials set encrypted_payload = ${encryptCredential("t", NEW).slice(0, -6)} where account_id = ${a}`;
    await expect(node()).rejects.toMatchObject({ code: 2 });
  });
});
