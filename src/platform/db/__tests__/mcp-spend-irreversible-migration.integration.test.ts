import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as script from "../../../../scripts/migrate.mjs";
import { readMcpSettings } from "../../../contexts/tenancy/domain/mcp-settings";
import { agentIrreversiblePolicy, agentSpendPolicy } from "../../../contexts/tenancy/domain/mcp-policy";
import { describeDb, TEST_DATABASE_URL } from "../../../test-support/db";
import { adminAndScratchUrls, folderUpTo, readJournal } from "../../../test-support/migration-test-kit";

/**
 * 0014 adds the spend and irreversible epochs to `mcp_tokens`. A token and an organization from before it gain nothing:
 * the new actions stay off. A 0.1.0 server keeps working on the migrated schema, because the new columns have defaults.
 */
describeDb("0014_mcp_spend_irreversible on existing rows", () => {
  const name = `miasdr_mcp_spend_${Math.random().toString(36).slice(2, 8)}`;
  const { admin, scratch } = adminAndScratchUrls(TEST_DATABASE_URL ?? "postgres://x@localhost/x", name);
  const adminSql = postgres(admin, { max: 1, onnotice: () => undefined });
  const env = { DATABASE_URL: scratch, DATABASE_SSL: "disable" };
  const migrate = async (folder: string) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      return await script.main(env, folder);
    } finally {
      log.mockRestore();
    }
  };
  let sql: postgres.Sql;
  let org: string;
  let user: string;
  let token: string;

  beforeAll(async () => {
    await adminSql.unsafe(`create database ${name}`);
    const before = readJournal().entries.find((entry) => entry.tag === "0014_mcp_spend_irreversible")!.idx - 1;
    expect(await migrate(folderUpTo(mkdtempSync(path.join(tmpdir(), "miasdr-0014-")), before))).toBe(0);
    sql = postgres(scratch, { max: 1, onnotice: () => undefined });
    [{ id: org }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values ('o-0014', 'o-0014') returning id`;
    [{ id: user }] = await sql<{ id: string }[]>`insert into users (name, email) values ('Owner', 'owner@0014.test') returning id`;
    await sql`insert into members (organization_id, user_id, role) values (${org}, ${user}, 'owner')`;
    await sql`insert into channel_settings (organization_id, channel, values) values (${org}, 'mcp', ${sql.json({ enabled: true, agentSendMode: "replies" })})`;
    [{ id: token }] = await sql<{ id: string }[]>`
      insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, token_hint, scopes)
      values (${org}, ${user}, 'pat', 'Old', 'hash-0014', 'abcd', ${["mcp:read", "mcp:write", "mcp:send"]}) returning id`;
    expect(await migrate(path.join(process.cwd(), "drizzle"))).toBe(0);
  });

  afterAll(async () => {
    await sql?.end();
    await adminSql.unsafe(`drop database if exists ${name} with (force)`);
    await adminSql.end();
  });

  it("leaves an existing token and organization unable to spend or take irreversible actions", async () => {
    const [row] = await sql<{ scopes: string[]; spend_epoch: number; irreversible_epoch: number; revoked_at: Date | null; expires_at: Date | null }[]>`select scopes, spend_epoch, irreversible_epoch, revoked_at, expires_at from mcp_tokens where id = ${token}`;
    expect(row).toMatchObject({ scopes: ["mcp:read", "mcp:write", "mcp:send"], spend_epoch: 0, irreversible_epoch: 0 });
    const [{ values }] = await sql<{ values: Record<string, unknown> }[]>`select values from channel_settings where organization_id = ${org} and channel = 'mcp'`;
    const settings = readMcpSettings(values);
    expect(settings).toMatchObject({ enabled: true, agentSendMode: "replies", agentSpendCentsPerDay: 0, agentSearchLeadsPerDay: 0, agentIrreversiblePerDay: 0 });
    const policyToken = { scopes: row.scopes, spendEpoch: row.spend_epoch, irreversibleEpoch: row.irreversible_epoch, revokedAt: row.revoked_at, expiresAt: row.expires_at };
    expect(agentSpendPolicy({ installEnabled: true, settings, token: policyToken, now: new Date() }).refusal).toBe("no_scope");
    expect(agentIrreversiblePolicy({ installEnabled: true, settings, token: policyToken, now: new Date() })).toBe("no_scope");
  });

  it("lets a 0.1.0 server insert tokens and read rows with the new scopes after a rollback", async () => {
    const [created] = await sql<{ spend_epoch: number; irreversible_epoch: number }[]>`
      insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, token_hint, scopes, policy_epoch)
      values (${org}, ${user}, 'pat', 'From 0.1.0', 'hash-0014-b', 'efgh', ${["mcp:read"]}, 0)
      returning spend_epoch, irreversible_epoch`;
    expect(created).toEqual({ spend_epoch: 0, irreversible_epoch: 0 });
    // 0.1.0 reads scopes through a list of the three it knows, so an unknown word is dropped.
    const known = ["mcp:read", "mcp:write", "mcp:send"];
    const [{ scopes }] = await sql<{ scopes: string[] }[]>`
      insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, token_hint, scopes)
      values (${org}, ${user}, 'pat', 'From 0.2.0', 'hash-0014-c', 'ijkl', ${["mcp:read", "mcp:write", "mcp:spend", "mcp:irreversible"]}) returning scopes`;
    expect(known.filter((scope) => scopes.includes(scope))).toEqual(["mcp:read", "mcp:write"]);
  });

  it("removes an organization's usage with the organization", async () => {
    const [{ id }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values ('o-0014-b', 'o-0014-b') returning id`;
    await sql`insert into mcp_agent_usage (organization_id, day, kind, amount) values (${id}, '2026-11-02', 'irreversible', 1)`;
    await sql`delete from organizations where id = ${id}`;
    expect(await sql`select 1 from mcp_agent_usage where organization_id = ${id}`).toHaveLength(0);
  });
});
