#!/usr/bin/env node
/**
 * Applies pending database migrations.
 *
 *   pnpm db:migrate                         on a development machine (reads .env when it exists)
 *   docker compose exec app node scripts/migrate.mjs
 *
 * Reads DATABASE_URL and DATABASE_SSL ("disable" for the bundled Postgres, otherwise TLS is required). Applies every
 * pending file in ../drizzle under the same advisory lock as the app, so it is safe next to a booting replica. It
 * refuses a Postgres older than 17 before it runs anything. Output carries counts, never the connection string.
 * Exit code: 0 done (including nothing pending), 1 bad usage, an unsupported server or a failed migration.
 *
 * This file runs under plain `node` in the production image, so it cannot import TypeScript. It repeats the lock key,
 * the version floor and the error unwrap from src/platform/db/migrate.ts, postgres-version.ts and migration-error.ts.
 * src/platform/db/__tests__/migrate-script.test.ts keeps the copies equal.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

export const ADVISORY_LOCK_KEY = 724105302;
// How long one statement waits for a table lock before the run fails and rolls back. Set after the advisory lock is
// held, so this script still waits as long as a replica migrates.
export const LOCK_TIMEOUT = "30s";
// The schema uses NULLS NOT DISTINCT and ON DELETE SET NULL (column), which need 15. The supported floor is 17,
// the version CI and the bundled compose file run.
export const MIN_POSTGRES_MAJOR = 17;

/** The database's own message sits in `cause`; Drizzle's message is the whole failed statement. */
export function readableMigrationError(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (!(current.cause instanceof Error)) break;
    current = current.cause;
  }
  if (current instanceof Error && current !== error) return new Error(`Migration failed: ${current.message}`, { cause: error });
  return error instanceof Error ? error : new Error(String(error));
}

export function unsupportedVersionMessage(versionNum) {
  const major = Math.floor(versionNum / 10000);
  if (major >= MIN_POSTGRES_MAJOR) return null;
  return `MiaSDR needs PostgreSQL ${MIN_POSTGRES_MAJOR} or newer, but this database reports version ${major}.${versionNum % 10000}. ` +
    `Upgrade the server, or point DATABASE_URL at a PostgreSQL ${MIN_POSTGRES_MAJOR}+ instance. See docs/database.md.`;
}

async function appliedCount(sql) {
  try {
    const [row] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    return row.n;
  } catch {
    return 0; // the table does not exist yet
  }
}

export async function main(env, migrationsFolder, options = {}) {
  if (!env.DATABASE_URL) return console.error("DATABASE_URL is not set."), 1;
  const sql = postgres(env.DATABASE_URL, { max: 1, ssl: env.DATABASE_SSL === "disable" ? false : "require", onnotice: () => undefined });
  try {
    const [{ v }] = await sql`select current_setting('server_version_num') as v`;
    const refusal = unsupportedVersionMessage(Number(v));
    if (refusal) return console.error(refusal), 1;
    await sql`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
    await sql`select set_config('lock_timeout', ${options.lockTimeout ?? LOCK_TIMEOUT}, false)`;
    const before = await appliedCount(sql);
    await migrate(drizzle(sql), { migrationsFolder });
    const after = await appliedCount(sql);
    console.log(after === before ? `Migrations: nothing pending (${after} applied).` : `Migrations: applied ${after - before} (${after} in total).`);
    return 0;
  } catch (error) {
    console.error(readableMigrationError(error).message);
    return 1;
  } finally {
    await sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`.catch(() => undefined);
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
  main(process.env, folder).then(
    (code) => process.exit(code),
    (error) => (console.error(error instanceof Error ? error.message : String(error)), process.exit(1)),
  );
}
