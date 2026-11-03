import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { rotateCredentials } from "../../../../../scripts/rotate-credentials.mjs";
import { credentialKeyId, decryptCredential, encryptCredential } from "../credential-crypto";
import { describeDb, dropOrgs, TEST_DATABASE_URL, testSql } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
const NEW = "n".repeat(40);
const OLD = "o".repeat(40);
const LOST = "l".repeat(40);

describeDb("credentials:rotate", () => {
  const sql = testSql({ max: 3 });
  const orgs: string[] = [];

  /** Every run scans the whole table, so each test clears the rows of the one before it. */
  async function seed() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id: orgId }] = await sql`insert into organizations (name, slug) values ('R', ${"rot-" + tag}) returning id`;
    orgs.push(orgId);
    const account = async (key: string, envelope: string, version: string) => {
      const [{ id }] = await sql`insert into integration_accounts (organization_id, key, name, kind) values (${orgId}, ${key}, ${key}, 'ai') returning id`;
      await sql`insert into integration_credentials (account_id, encrypted_payload, encryption_version) values (${id}, ${envelope}, ${version})`;
      return id as string;
    };
    return { account };
  }
  const payload = async (id: string) => (await sql`select encrypted_payload, encryption_version from integration_credentials where account_id = ${id}`)[0];
  const run = (apply: boolean) => rotateCredentials({ sql, currentKey: NEW, legacyKeys: [OLD], apply });

  beforeAll(async () => {
    await sql`delete from integration_credentials`;
  });
  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    await sql.end();
  });

  it("dry run counts rows and changes nothing", async () => {
    const s = await seed();
    const a = await s.account("anthropic", encryptCredential("A", OLD), "v2");
    const g = await s.account("hunter", encryptCredential("G", OLD), "v2");
    const before = [await payload(a), await payload(g)];
    const report = await run(false);
    expect(report.apply).toBe(false);
    expect(report).toMatchObject({ total: 2, current: 0, rotated: 2, undecryptable: [] });
    expect(report.bySourceKey).toEqual({ [credentialKeyId(OLD)]: 2 });
    expect([await payload(a), await payload(g)]).toEqual(before);
    await sql`delete from organizations where id = (select organization_id from integration_accounts where id = ${a})`;
  });

  it("apply re-encrypts, rows decrypt with the new key alone, and a second run changes nothing", async () => {
    const s = await seed();
    const a = await s.account("anthropic", encryptCredential('{"apiKey":"one"}', OLD), "v2");
    const g = await s.account("hunter", encryptCredential('{"apiKey":"two"}', OLD), "v2");
    const report = await run(true);
    expect(report.rotated).toBe(2);
    const rowA = await payload(a);
    const rowG = await payload(g);
    expect(decryptCredential(rowA.encrypted_payload, NEW)).toBe('{"apiKey":"one"}');
    expect(decryptCredential(rowG.encrypted_payload, NEW)).toBe('{"apiKey":"two"}');
    expect(rowA.encrypted_payload.startsWith(`v2:${credentialKeyId(NEW)}:`)).toBe(true);
    expect([rowA.encryption_version, rowG.encryption_version]).toEqual(["v2", "v2"]);

    const again = await run(true);
    expect(again).toMatchObject({ total: 2, current: 2, rotated: 0 });
    expect(await payload(a)).toEqual(rowA);
    expect(await payload(g)).toEqual(rowG);
  });

  it("lists an undecryptable row, leaves it untouched and rotates the others", async () => {
    const s = await seed();
    const bad = await s.account("anthropic", encryptCredential("lost", LOST), "v2");
    const good = await s.account("hunter", encryptCredential("kept", OLD), "v2");
    const badBefore = await payload(bad);
    const report = await run(true);
    expect(report.undecryptable).toEqual([{ id: bad, reason: `no known key for key id ${credentialKeyId(LOST)}` }]);
    expect(JSON.stringify(report)).not.toContain(LOST);
    expect(await payload(bad)).toEqual(badBefore);
    const row = await payload(good);
    expect(decryptCredential(row.encrypted_payload, NEW)).toBe("kept");
  });

  it("opens rows on the current key too: a truncated payload and a tampered tag are undecryptable and untouched", async () => {
    await sql`delete from integration_credentials`;
    const s = await seed();
    const good = encryptCredential("fine", NEW);
    const [v, id, iv, tag, body] = encryptCredential("tampered", NEW).split(":");
    const flipped = (tag[0] === "A" ? "B" : "A") + tag.slice(1);
    const truncated = encryptCredential("truncated", NEW).slice(0, -6);
    const a = await s.account("anthropic", [v, id, iv, flipped, body].join(":"), "v2");
    const b = await s.account("hunter", truncated, "v2");
    const c = await s.account("apollo", good, "v2");
    const before = [await payload(a), await payload(b), await payload(c)];
    for (const apply of [false, true]) {
      const report = await run(apply);
      expect(report.undecryptable.map((u: { id: string }) => u.id).sort()).toEqual([a, b].sort());
      expect(report).toMatchObject({ total: 3, current: 1, rotated: 0 });
      expect(JSON.stringify(report)).not.toContain(NEW);
      expect([await payload(a), await payload(b), await payload(c)]).toEqual(before);
    }
  });

  it("runs under plain node: dry run by default, --apply writes, output holds no key", async () => {
    await sql`delete from integration_credentials`;
    const s = await seed();
    const a = await s.account("anthropic", encryptCredential("node-run", OLD), "v2");
    const env = { PATH: process.env.PATH, DATABASE_URL: TEST_DATABASE_URL, DATABASE_SSL: "disable", INTEGRATION_CREDENTIALS_KEY: NEW, INTEGRATION_CREDENTIALS_LEGACY_KEYS: OLD };
    const node = (...args: string[]) => promisify(execFile)(process.execPath, ["scripts/rotate-credentials.mjs", ...args], { env: { ...env, NODE_ENV: "test" } as NodeJS.ProcessEnv, cwd: process.cwd() });

    const dry = await node();
    expect(dry.stdout).toContain("Dry run");
    expect(dry.stdout).toContain(`Current key id: ${credentialKeyId(NEW)}`);
    expect((await payload(a)).encrypted_payload.startsWith(`v2:${credentialKeyId(OLD)}:`)).toBe(true);

    const applied = await node("--apply");
    expect(applied.stdout).toContain("integration_credentials: 1 rows, 0 already on the current key, 1 rotated");
    expect(applied.stdout + applied.stderr).not.toMatch(new RegExp(`${NEW}|${OLD}|node-run`));
    expect(decryptCredential((await payload(a)).encrypted_payload, NEW)).toBe("node-run");

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
