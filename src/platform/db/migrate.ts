import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { env } from "@/shared/env";
import { readableMigrationError } from "./migration-error";
import { assertPostgresSupported } from "./postgres-version";

/** The advisory lock key every migration run holds. scripts/migrate.mjs uses the same key. */
export const MIGRATION_LOCK_KEY = 724105302;

/**
 * How long one migration statement waits for a table lock before the run fails and rolls back. An old instance that
 * still holds a lock on a table would otherwise keep the boot waiting with no end. scripts/migrate.mjs uses the same value.
 */
export const MIGRATION_LOCK_TIMEOUT = "30s";

/**
 * Applies pending migrations under an advisory lock so replicas do not race. The lock timeout is set after the advisory
 * lock is held, so a replica still waits as long as another replica migrates.
 */
export async function runMigrations(options: { lockTimeout?: string } = {}): Promise<void> {
  const e = env();
  const client = postgres(e.DATABASE_URL, { ssl: e.DATABASE_SSL === "disable" ? false : "require", max: 1 });
  try {
    // Before the first migration: on Postgres 14 the first migration otherwise fails with a bare syntax error.
    await assertPostgresSupported(client as never);
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    await client`select set_config('lock_timeout', ${options.lockTimeout ?? MIGRATION_LOCK_TIMEOUT}, false)`;
    await migrate(drizzle(client), { migrationsFolder: path.join(process.cwd(), "drizzle") });
  } catch (error) {
    throw readableMigrationError(error);
  } finally {
    await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => undefined);
    await client.end();
  }
}
