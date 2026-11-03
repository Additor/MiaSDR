import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "./client";
import { rowsOf } from "./sql-values";

/** The build's journal, read once: Settings asks on every render, and a build never changes its migrations. */
let shipped: number | null = null;

/**
 * How many migrations this build ships that the database has not applied. With RUN_MIGRATIONS=false an operator runs them by
 * hand, and a missed one first shows as a failed query. Null when either count cannot be read, which says nothing either way.
 */
export async function pendingMigrations(): Promise<number | null> {
  try {
    shipped ??= (JSON.parse(readFileSync(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;
    const [row] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`));
    return Math.max(shipped - row.n, 0);
  } catch {
    return null;
  }
}
