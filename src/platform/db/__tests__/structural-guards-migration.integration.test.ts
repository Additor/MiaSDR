import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as script from "../../../../scripts/migrate.mjs";
import { describeDb, TEST_DATABASE_URL } from "../../../test-support/db";
import { adminAndScratchUrls, folderUpTo } from "../../../test-support/migration-test-kit";

/**
 * 0004_structural_guards adds a unique index on the in-flight draft of a conversation. Only a send attempt settles an
 * in-flight draft, so the migration changes no rows: on a database where a conversation holds two, it stops and names
 * both drafts. A scratch database at 0003 gets such a pair. Needs TEST_DATABASE_URL. Builds and drops its own database.
 */
describeDb("0004_structural_guards on existing rows", () => {
  const name = `miasdr_structural_guards_${Math.random().toString(36).slice(2, 8)}`;
  const { admin, scratch } = adminAndScratchUrls(TEST_DATABASE_URL ?? "postgres://x@localhost/x", name);
  const adminSql = postgres(admin, { max: 1, onnotice: () => undefined });
  const env = { DATABASE_URL: scratch, DATABASE_SSL: "disable" };
  const errors: string[] = [];
  const migrate = async (folder: string) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation((message: unknown) => void errors.push(String(message)));
    try {
      return await script.main(env, folder);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  };
  let sql: postgres.Sql;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await adminSql.unsafe(`create database ${name}`);
    expect(await migrate(folderUpTo(mkdtempSync(path.join(tmpdir(), "miasdr-0004-")), 3))).toBe(0);
    sql = postgres(scratch, { max: 1, onnotice: () => undefined });
    const one = async (rows: PromiseLike<Array<{ id: string }>>) => (await rows)[0].id;
    ids.org = await one(sql`insert into organizations (name, slug) values ('o-0004', 'o-0004') returning id`);
    const person = await one(sql`insert into people (organization_id, email, full_name) values (${ids.org}, 'lead@0004.test', 'Lead') returning id`);
    const set = await one(sql`insert into reply_type_sets (organization_id, name, is_default) values (${ids.org}, 'p', true) returning id`);
    const record = await one(sql`insert into records (organization_id, person_id, reply_type_set_id) values (${ids.org}, ${person}, ${set}) returning id`);
    ids.conversation = await one(sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${ids.org}, ${record}, 'email', 'me@0004.test') returning id`);
    ids.record = record;
    const draft = async (status: string) =>
      one(sql`
        insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, status)
        values (${ids.org}, ${record}, ${ids.conversation}, 0, 'email', ${status}) returning id`);
    ids.sending = await draft("sending");
    ids.uncertain = await draft("delivery_uncertain");
  });
  afterAll(async () => {
    await sql?.end();
    await adminSql.unsafe(`drop database if exists ${name} with (force)`);
    await adminSql.end();
  });

  it("stops on a conversation with two drafts in flight, names both and changes no row", async () => {
    expect(await migrate(path.join(process.cwd(), "drizzle"))).toBe(1);
    const message = errors.join("\n");
    expect(message).toContain("more than one draft in flight");
    expect(message).toContain(ids.conversation);
    expect(message).toContain(ids.sending);
    expect(message).toContain(ids.uncertain);
    const rows = await sql`select status from drafts where conversation_id = ${ids.conversation} order by status`;
    expect(rows.map((r) => r.status)).toEqual(["delivery_uncertain", "sending"]);
    const [{ n }] = await sql`select count(*)::int as n from information_schema.columns where table_name = 'ai_jobs' and column_name = 'claim_token'`;
    expect(n).toBe(0);
  });

  it("applies once a person settles the pair, and then holds one draft in flight per conversation", async () => {
    await sql`delete from drafts where id = ${ids.uncertain}`;
    expect(await migrate(path.join(process.cwd(), "drizzle"))).toBe(0);
    await expect(
      sql`
        insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, status)
        values (${ids.org}, ${ids.record}, ${ids.conversation}, 0, 'email', 'delivery_uncertain')`,
    ).rejects.toThrow(/drafts_one_in_flight_uq/);
    await sql`
      insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, status)
      values (${ids.org}, ${ids.record}, ${ids.conversation}, 0, 'email', 'awaiting_review')`;
  });
});
