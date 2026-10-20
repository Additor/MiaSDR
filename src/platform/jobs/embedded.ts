import { tickObserver } from "./observe";
import { setKickRunner } from "./kick";
import { runTick } from "./tick";
import type { Job, TickReport } from "./types";

/**
 * Self-host mode: tick inside the app process. Ticks never overlap within one
 * process; claim logic inside each job covers overlap across processes.
 * Each report goes to the observer, which logs failed jobs and slow ticks and records failures for the jobs page.
 */
export function startEmbeddedScheduler(
  jobs: readonly Job[],
  intervalMs = 60_000,
  observe: (report: TickReport) => Promise<void> = (report) => tickObserver.observe(report),
) {
  let running = false;
  const budgetMs = Math.min(intervalMs, 50_000);
  // A kicked pass runs on its own slot, outside the `running` guard of the tick, and a job's claims keep the two from overlapping on a cell.
  setKickRunner(async (names) => {
    const report = await runTick(jobs.filter((job) => names.includes(job.name)), budgetMs);
    await observe(report).catch(() => undefined);
    return { again: report.jobs.filter((job) => job.more && !job.error && job.processed > 0).map((job) => job.name) };
  });
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const report = await runTick(jobs, budgetMs);
      await observe(report);
    } catch (error) {
      console.error(`[jobs] ${JSON.stringify({ event: "tick.crashed", error: error instanceof Error ? error.message : String(error) })}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    setKickRunner(null);
  };
}
