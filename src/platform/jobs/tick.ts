import type { Job, TickReport } from "./types";

const DEFAULT_BUDGET_MS = 50_000;

/**
 * Run every registered job once, inside one time budget. A failing job is
 * reported and does not stop the others.
 */
export async function runTick(
  jobs: readonly Job[],
  budgetMs: number = DEFAULT_BUDGET_MS,
): Promise<TickReport> {
  const started = Date.now();
  const deadline = started + budgetMs;
  const report: TickReport = {
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    jobs: [],
  };

  for (const job of jobs) {
    if (Date.now() >= deadline) {
      report.jobs.push({ name: job.name, processed: 0, more: true });
      continue;
    }
    const jobStarted = Date.now();
    try {
      const result = await job.run({ deadline, now: () => new Date() });
      report.jobs.push({ name: job.name, ...result, durationMs: Date.now() - jobStarted });
    } catch (error) {
      report.jobs.push({
        name: job.name,
        processed: 0,
        more: true,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - jobStarted,
      });
    }
  }

  report.durationMs = Date.now() - started;
  return report;
}
