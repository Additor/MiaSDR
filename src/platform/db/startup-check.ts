import { UnsupportedPostgresError, verifyPostgresVersion } from "./postgres-version";

/**
 * Startup guard for `src/instrumentation.ts`. Stops the server with a readable message on PostgreSQL older than 15.
 * Lives here, not in instrumentation.ts, because Next compiles that file for the Edge runtime too and warns about
 * `process.exit` there. Runs whether or not migrations are on.
 */
export async function requireSupportedPostgres(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await verifyPostgresVersion(process.env.DATABASE_URL, process.env.DATABASE_SSL === "disable" ? false : "require");
  } catch (error) {
    if (!(error instanceof UnsupportedPostgresError)) throw error;
    console.error(`[miasdr] ${error.message}`);
    process.exit(1);
  }
}
