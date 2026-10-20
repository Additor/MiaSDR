import { recordTickFailure, type TickFailure } from "./failure-log";
import type { TickReport } from "./types";

/**
 * Turns a tick report into log lines and failure records. The embedded scheduler and the cron endpoint both call it,
 * so a failing job is visible in the container log in either mode.
 *
 * Volume protection: a job that fails the same way every minute logs once, then once per `repeatEveryMs` with the
 * number of ticks it skipped. A different error logs at once. A job that recovers logs one line and starts clean.
 */
export interface ObserverOptions {
  log?: (level: "error" | "warn" | "info", line: string) => void;
  persist?: (failure: TickFailure) => Promise<void>;
  now?: () => number;
  repeatEveryMs?: number;
  slowTickMs?: number;
}

export const DEFAULT_REPEAT_LOG_MS = 10 * 60_000;
export const DEFAULT_SLOW_TICK_MS = 30_000;

interface Seen {
  signature: string;
  firstSeenAt: number;
  occurrences: number;
  lastLoggedAt: number;
  skipped: number;
}

/** Numbers and ids vary between runs of the same fault. Removing them lets repeats collapse. */
export function failureSignature(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\d+/g, "#")
    .slice(0, 160);
}

/** The failure a job reports in this tick, from a thrown error or from a count of failed items in its detail. */
export function failureOf(job: TickReport["jobs"][number]): string | null {
  if (job.error) return job.error;
  const failed = Object.entries(job.detail ?? {}).filter(([key, n]) => /fail|error/i.test(key) && n > 0);
  if (failed.length === 0) return null;
  // A detail key reads as words: "1 mailboxes failed", not "1 mailboxes_failed".
  return failed.map(([key, n]) => `${n} ${key.replace(/_/g, " ")}`).join(", ");
}

export function createTickObserver(options: ObserverOptions = {}) {
  const log = options.log ?? ((level, line) => (level === "info" ? console.info : level === "warn" ? console.warn : console.error)(line));
  const persist = options.persist ?? recordTickFailure;
  const now = options.now ?? Date.now;
  const repeatEveryMs = options.repeatEveryMs ?? DEFAULT_REPEAT_LOG_MS;
  const slowTickMs = options.slowTickMs ?? DEFAULT_SLOW_TICK_MS;
  const seen = new Map<string, Seen>();
  const slow = { lastLoggedAt: 0, skipped: 0 };

  const line = (fields: Record<string, unknown>) => `[jobs] ${JSON.stringify(fields)}`;

  return {
    async observe(report: TickReport): Promise<void> {
      const t = now();
      const failing = new Set<string>();

      for (const job of report.jobs) {
        const message = failureOf(job);
        if (!message) continue;
        failing.add(job.name);
        const signature = failureSignature(message);
        const key = `${job.name}\u0000${signature}`;
        const entry = seen.get(key) ?? { signature, firstSeenAt: t, occurrences: 0, lastLoggedAt: 0, skipped: 0 };
        entry.occurrences += 1;
        seen.set(key, entry);
        if (entry.occurrences > 1 && t - entry.lastLoggedAt < repeatEveryMs) {
          entry.skipped += 1;
          continue;
        }
        log("error", line({ event: "job.failed", job: job.name, error: message.slice(0, 500), processed: job.processed, detail: job.detail, tickStartedAt: report.startedAt, repeatedSinceLastLine: entry.skipped, occurrences: entry.occurrences }));
        entry.lastLoggedAt = t;
        entry.skipped = 0;
        try {
          await persist({ job: job.name, signature, message, occurrences: entry.occurrences, firstSeenAt: new Date(entry.firstSeenAt), now: new Date(t) });
        } catch (error) {
          // The log line above already carries the failure. A broken database must not stop the scheduler.
          log("warn", line({ event: "job.failure_record_failed", job: job.name, error: error instanceof Error ? error.message : String(error) }));
        }
      }

      // A job that ran clean this tick closes its failure series.
      for (const [key, entry] of seen) {
        const name = key.slice(0, key.indexOf("\u0000"));
        if (failing.has(name) || !report.jobs.some((j) => j.name === name && !(j.processed === 0 && j.more && !j.error))) continue;
        seen.delete(key);
        if (entry.lastLoggedAt > 0) log("info", line({ event: "job.recovered", job: name, occurrences: entry.occurrences }));
      }

      if (report.durationMs >= slowTickMs) {
        if (slow.lastLoggedAt === 0 || t - slow.lastLoggedAt >= repeatEveryMs) {
          const slowest = [...report.jobs].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 3).map((j) => ({ job: j.name, durationMs: j.durationMs ?? null }));
          log("warn", line({ event: "tick.slow", durationMs: report.durationMs, thresholdMs: slowTickMs, jobs: report.jobs.length, slowest, tickStartedAt: report.startedAt, repeatedSinceLastLine: slow.skipped }));
          slow.lastLoggedAt = t;
          slow.skipped = 0;
        } else slow.skipped += 1;
      }
    },
  };
}

export const tickObserver = createTickObserver();
