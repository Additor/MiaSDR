import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as script from "../../../../scripts/migrate.mjs";
import { describeDb, TEST_DATABASE_URL } from "../../../test-support/db";
import { adminAndScratchUrls, folderUpTo, readJournal } from "../../../test-support/migration-test-kit";

/** Needs TEST_DATABASE_URL (any database on the test server). Builds and drops its own scratch database. */
describeDb("scripts/migrate.mjs against an empty database", () => {
  const name = `miasdr_migrate_script_${Math.random().toString(36).slice(2, 8)}`;
  const { admin, scratch } = adminAndScratchUrls(TEST_DATABASE_URL ?? "postgres://x@localhost/x", name);
  const adminSql = postgres(admin, { max: 1, onnotice: () => undefined });
  const migrations = path.join(process.cwd(), "drizzle");
  const env = { DATABASE_URL: scratch, DATABASE_SSL: "disable" };

  beforeAll(async () => {
    await adminSql.unsafe(`create database ${name}`);
  });
  afterAll(async () => {
    await adminSql.unsafe(`drop database if exists ${name} with (force)`);
    await adminSql.end();
  });

  const lines = async (run: () => Promise<number>) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await run();
      return { code, out: log.mock.calls.flat().join("\n"), err: error.mock.calls.flat().join("\n") };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  };

  it("applies every migration, then reports nothing pending", async () => {
    const total = readJournal().entries.length;
    const first = await lines(() => script.main(env, migrations));
    expect(first).toMatchObject({ code: 0 });
    expect(first.out).toContain(`applied ${total} (${total} in total)`);

    const sql = postgres(scratch, { max: 1 });
    const [{ n }] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    const [{ t }] = await sql`select to_regclass('public.people') is not null as t`;
    await sql.end();
    expect(n).toBe(total);
    expect(t).toBe(true);

    const second = await lines(() => script.main(env, migrations));
    expect(second.code).toBe(0);
    expect(second.out).toContain("nothing pending");
  });

  it("applies only the pending files on a database that is partly migrated", async () => {
    const partial = `${name}_p`;
    await adminSql.unsafe(`create database ${partial}`);
    try {
      const partialUrl = adminAndScratchUrls(TEST_DATABASE_URL ?? "", partial).scratch;
      const upTo = folderUpTo(mkdtempSync(path.join(tmpdir(), "migrate-script-")), 5);
      const first = await lines(() => script.main({ DATABASE_URL: partialUrl, DATABASE_SSL: "disable" }, upTo));
      expect(first.out).toContain("applied 6 (6 in total)");
      const rest = await lines(() => script.main({ DATABASE_URL: partialUrl, DATABASE_SSL: "disable" }, migrations));
      const total = readJournal().entries.length;
      expect(rest.out).toContain(`applied ${total - 6} (${total} in total)`);
    } finally {
      await adminSql.unsafe(`drop database if exists ${partial} with (force)`);
    }
  });

  it("exits 1 without DATABASE_URL and never prints a connection string", async () => {
    const result = await lines(() => script.main({}, migrations));
    expect(result).toMatchObject({ code: 1, err: "DATABASE_URL is not set." });
  });

  it("exits 1 with a message when the database is unreachable, without the password", async () => {
    const bad = "postgres://user:s3cretpw@127.0.0.1:1/none";
    const result = await lines(() => script.main({ DATABASE_URL: bad, DATABASE_SSL: "disable" }, migrations));
    expect(result.code).toBe(1);
    expect(result.err).not.toContain("s3cretpw");
  });
});
