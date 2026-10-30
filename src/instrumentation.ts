export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `next build` imports this file too; only a running server should touch the database.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { flag } = await import("./shared/env");
  // Validate the flags before any migration runs, so a typo stops the boot with the variable named. MCP_ENABLED is read
  // later through env(), where a typo would fail every route instead.
  const runMigrationsFlag = flag(process.env.RUN_MIGRATIONS, true, "RUN_MIGRATIONS");
  const embeddedScheduler = flag(process.env.EMBEDDED_SCHEDULER, true, "EMBEDDED_SCHEDULER");
  flag(process.env.MCP_ENABLED, true, "MCP_ENABLED");
  const { isOutboundPauseUnreadable } = await import("./shared/outbound-pause");
  if (isOutboundPauseUnreadable()) {
    console.warn(`PAUSE_OUTBOUND: "${process.env.PAUSE_OUTBOUND}" is not a boolean, so outbound sending is paused. Use one of 1, true, yes, on, 0, false, no, off.`);
  }
  const { requireSupportedPostgres } = await import("./platform/db/startup-check");
  await requireSupportedPostgres();

  if (runMigrationsFlag && process.env.NODE_ENV === "production") {
    const { runMigrations } = await import("./platform/db/migrate");
    await runMigrations();
  }

  if (!embeddedScheduler) return;
  const { startEmbeddedScheduler } = await import("./platform/jobs/embedded");
  const { registeredJobs } = await import("./composition/job-registry");
  startEmbeddedScheduler(registeredJobs());
}
