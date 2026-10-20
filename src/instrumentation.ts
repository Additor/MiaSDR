export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `next build` imports this file too; only a running server should touch the database.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { flag } = await import("./shared/env");
  // Validate both flags before any migration runs, so a typo stops the boot with the variable named.
  const runMigrationsFlag = flag(process.env.RUN_MIGRATIONS, true, "RUN_MIGRATIONS");
  const embeddedScheduler = flag(process.env.EMBEDDED_SCHEDULER, true, "EMBEDDED_SCHEDULER");
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
