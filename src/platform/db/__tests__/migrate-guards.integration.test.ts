import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as script from "../../../../scripts/migrate.mjs";
import { describeDb, TEST_DATABASE_URL, useTestEnv } from "../../../test-support/db";
import { adminAndScratchUrls, readJournal } from "../../../test-support/migration-test-kit";

/**
 * The two migrators and the startup check refuse an old server before they touch the schema, and both migrators wait for
 * the advisory lock another session holds (decisions.md "Environment and boot"). Needs TEST_DATABASE_URL. Builds and drops
 * its own scratch databases.
 *
 * `server_version_num` is read-only, so the old-server cases put a `stub.current_setting` ahead of pg_catalog in the
 * scratch database's search_path. The code under test runs its unchanged query against a real server.
 */
const LOCK_KEY = 724105302;
const OLD_SERVER = "160004";

describeDb("migration guards", () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const names = { old: `miasdr_guard_old_${suffix}`, lockScript: `miasdr_guard_lock_s_${suffix}`, lockApp: `miasdr_guard_lock_a_${suffix}` };
  const url = (name: string) => adminAndScratchUrls(TEST_DATABASE_URL ?? "postgres://x@localhost/x", name).scratch;
  const { admin } = adminAndScratchUrls(TEST_DATABASE_URL ?? "postgres://x@localhost/x", names.old);
  const adminSql = postgres(admin, { max: 1, onnotice: () => undefined });
  const migrations = path.join(process.cwd(), "drizzle");
  const total = readJournal().entries.length;

  // runMigrations reads DATABASE_URL through env(), which caches the first read, so the app-side cases share one URL.
  useTestEnv({ DATABASE_URL: url(names.lockApp) });

  beforeAll(async () => {
    for (const name of Object.values(names)) await adminSql.unsafe(`create database ${name}`);
    const old = postgres(url(names.old), { max: 1, onnotice: () => undefined });
    await old.unsafe(`
      create schema stub;
      create function stub.current_setting(text) returns text language sql
        as $$ select case when $1 = 'server_version_num' then '${OLD_SERVER}' else pg_catalog.current_setting($1) end $$;
      alter database ${names.old} set search_path = stub, pg_catalog, public;`);
    await old.end();
  });
  afterAll(async () => {
    for (const name of Object.values(names)) await adminSql.unsafe(`drop database if exists ${name} with (force)`);
    await adminSql.end();
  });

  /** What the migrators left in a database: the ledger row count (null without the table) and whether `people` exists. */
  async function applied(name: string): Promise<{ ledger: number | null; people: boolean }> {
    const sql = postgres(url(name), { max: 1, onnotice: () => undefined });
    try {
      const [{ ledger, people }] = await sql`
        select to_regclass('drizzle.__drizzle_migrations') is not null as ledger, to_regclass('public.people') is not null as people`;
      const count = ledger ? (await sql`select count(*)::int as n from drizzle.__drizzle_migrations`)[0].n : null;
      return { ledger: count, people };
    } finally {
      await sql.end();
    }
  }

  const quiet = () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    return { log, error, restore: () => (log.mockRestore(), error.mockRestore()) };
  };

  /**
   * Starts `run` while another session holds the migration lock. Resolves once the run waits on that lock or settles,
   * and reports which happened together with what the database held at that moment.
   */
  async function underHeldLock(name: string, run: () => Promise<unknown>) {
    const holder = postgres(url(name), { max: 1, onnotice: () => undefined });
    await holder`select pg_advisory_lock(${LOCK_KEY})`;
    let settled = false;
    const pending = run().finally(() => {
      settled = true;
    });
    const until = Date.now() + 10_000;
    let waiting = 0;
    while (!settled && Date.now() < until) {
      [{ waiting }] = await holder<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid() and query ilike '%pg_advisory_lock%'`;
      if (waiting > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const whileHeld = { settled, waiting, ...(await applied(name)) };
    await holder`select pg_advisory_unlock(${LOCK_KEY})`;
    await holder.end();
    return { whileHeld, result: await pending };
  }

  describe("an old server", () => {
    it("scripts/migrate.mjs exits 1 with the version message and applies nothing", async () => {
      const out = quiet();
      try {
        const code = await script.main({ DATABASE_URL: url(names.old), DATABASE_SSL: "disable" }, migrations);
        expect(code).toBe(1);
        expect(out.error.mock.calls.flat().join("\n")).toContain("this database reports version 16.4");
      } finally {
        out.restore();
      }
      expect(await applied(names.old)).toEqual({ ledger: null, people: false });
    });

    it("runMigrations refuses with UnsupportedPostgresError and applies nothing", async () => {
      vi.stubEnv("DATABASE_URL", url(names.old));
      vi.resetModules();
      try {
        const { runMigrations } = await import("../migrate");
        await expect(runMigrations()).rejects.toThrow(/this database reports version 16\.4/);
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
      expect(await applied(names.old)).toEqual({ ledger: null, people: false });
    });

    it("server start exits 1 before it runs a migration", async () => {
      vi.stubEnv("DATABASE_URL", url(names.old));
      vi.stubEnv("NEXT_RUNTIME", "nodejs");
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("RUN_MIGRATIONS", "true");
      vi.stubEnv("EMBEDDED_SCHEDULER", "false");
      vi.resetModules();
      const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      });
      const out = quiet();
      try {
        const { register } = await import("../../../instrumentation");
        await expect(register()).rejects.toThrow("process.exit(1)");
        expect(exit).toHaveBeenCalledWith(1);
        expect(out.error.mock.calls.flat().join("\n")).toContain("this database reports version 16.4");
      } finally {
        out.restore();
        exit.mockRestore();
        vi.unstubAllEnvs();
        vi.resetModules();
      }
      expect(await applied(names.old)).toEqual({ ledger: null, people: false });
    });
  });

  describe("a held migration lock", () => {
    it("scripts/migrate.mjs waits for it, then applies every migration", async () => {
      const out = quiet();
      try {
        const { whileHeld, result } = await underHeldLock(names.lockScript, () => script.main({ DATABASE_URL: url(names.lockScript), DATABASE_SSL: "disable" }, migrations));
        expect(whileHeld).toEqual({ settled: false, waiting: 1, ledger: null, people: false });
        expect(result).toBe(0);
      } finally {
        out.restore();
      }
      expect(await applied(names.lockScript)).toEqual({ ledger: total, people: true });
    });

    it("runMigrations waits for it, then applies every migration", async () => {
      vi.resetModules();
      const { runMigrations } = await import("../migrate");
      const { whileHeld } = await underHeldLock(names.lockApp, () => runMigrations());
      expect(whileHeld).toEqual({ settled: false, waiting: 1, ledger: null, people: false });
      expect(await applied(names.lockApp)).toEqual({ ledger: total, people: true });
    });
  });

  /**
   * An old instance that holds a table lock. The migrator reads its ledger first, so a session holding the ledger table
   * stands in for it. Runs after "a held migration lock", which left both databases migrated.
   */
  describe("a held table lock", () => {
    /** Runs `run` while another session holds the ledger table in an open transaction, then says whether the advisory lock is free. */
    async function underTableLock(name: string, run: () => Promise<unknown>) {
      const holder = postgres(url(name), { max: 1, onnotice: () => undefined });
      try {
        let result: unknown;
        await holder.begin(async (tx) => {
          await tx`lock table drizzle.__drizzle_migrations in access exclusive mode`;
          result = await run().catch((error: unknown) => error);
        });
        const [{ free }] = await holder<{ free: boolean }[]>`select pg_try_advisory_lock(${LOCK_KEY}) as free`;
        if (free) await holder`select pg_advisory_unlock(${LOCK_KEY})`;
        return { result, advisoryFree: free };
      } finally {
        await holder.end();
      }
    }

    it("scripts/migrate.mjs fails with the lock timeout and frees the advisory lock", async () => {
      const out = quiet();
      try {
        const started = Date.now();
        const { result, advisoryFree } = await underTableLock(names.lockScript, () =>
          script.main({ DATABASE_URL: url(names.lockScript), DATABASE_SSL: "disable" }, migrations, { lockTimeout: "300ms" }),
        );
        expect(result).toBe(1);
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(out.error.mock.calls.flat().join("\n")).toContain("lock timeout");
        expect(advisoryFree).toBe(true);
      } finally {
        out.restore();
      }
    });

    it("runMigrations fails with the lock timeout and frees the advisory lock", async () => {
      vi.resetModules();
      const { runMigrations } = await import("../migrate");
      const { result, advisoryFree } = await underTableLock(names.lockApp, () => runMigrations({ lockTimeout: "300ms" }));
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("lock timeout");
      expect(advisoryFree).toBe(true);
    });
  });
});
