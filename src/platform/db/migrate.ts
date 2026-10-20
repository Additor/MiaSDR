import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { env } from "@/shared/env";
import { readableMigrationError } from "./migration-error";
import { assertPostgresSupported } from "./postgres-version";

/** The advisory lock key every migration run holds. scripts/migrate.mjs uses the same key. */
export const MIGRATION_LOCK_KEY = 724105302;

/** Applies pending migrations under an advisory lock so replicas do not race. */
export async function runMigrations(): Promise<void> {
  const e = env();
  const client = postgres(e.DATABASE_URL, { ssl: e.DATABASE_SSL === "disable" ? false : "require", max: 1 });
  try {
    // Before the first migration: on Postgres 14 the first migration otherwise fails with a bare syntax error.
    await assertPostgresSupported(client as never);
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    await migrate(drizzle(client), { migrationsFolder: path.join(process.cwd(), "drizzle") });
  } catch (error) {
    throw readableMigrationError(error);
  } finally {
    await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => undefined);
    await client.end();
  }
}
