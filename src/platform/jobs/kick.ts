/**
 * Post-response kick. A request that queues work (a grid run, a retry, an auto-run after an edit) calls `kickJob`
 * so this process runs the job at once instead of waiting for the next scheduler tick.
 *
 * - The kick never runs inside the request: it only schedules a timer and returns. It never throws.
 * - At most one kicked pass runs at a time per process. A kick that arrives meanwhile is remembered and
 *   served by one follow-up pass, so work queued after the pass last claimed is not missed.
 * - A pass that reports `more: true` runs again right away until the queue is empty.
 * - Other instances and a process without an embedded scheduler have no runner and ignore the kick; the tick picks the work up.
 *
 * State lives on `globalThis` because Next bundles route handlers and `instrumentation.ts` separately, and both must see the same runner.
 */
export type KickRunner = (jobNames: string[]) => Promise<{ again: string[] }>;

/** Pause between the kick and the pass. It lets the response that triggered the kick leave first. */
export const KICK_DELAY_MS = 25;

interface KickState {
  runner: KickRunner | null;
  pending: Set<string>;
  scheduled: boolean;
  running: boolean;
}

const globalForKick = globalThis as unknown as { __miasdrKick?: KickState };
const state = (): KickState => (globalForKick.__miasdrKick ??= { runner: null, pending: new Set(), scheduled: false, running: false });

/** The embedded scheduler registers its runner on start and clears it on stop. */
export function setKickRunner(runner: KickRunner | null): void {
  const s = state();
  s.runner = runner;
  if (!runner) s.pending.clear();
}

async function drain(): Promise<void> {
  const s = state();
  s.scheduled = false;
  s.running = true;
  try {
    while (s.runner && s.pending.size > 0) {
      const names = [...s.pending];
      s.pending.clear();
      try {
        const { again } = await s.runner(names);
        for (const name of again) s.pending.add(name);
      } catch (error) {
        console.error(`[jobs] ${JSON.stringify({ event: "kick.failed", jobs: names, error: error instanceof Error ? error.message : String(error) })}`);
      }
    }
  } finally {
    s.running = false;
  }
}

/** Asks this process to run `jobName` soon. Safe to call from a request: it returns at once and never throws. */
export function kickJob(jobName: string): void {
  try {
    const s = state();
    if (!s.runner) return;
    s.pending.add(jobName);
    if (s.running || s.scheduled) return;
    s.scheduled = true;
    const timer = setTimeout(() => void drain(), KICK_DELAY_MS);
    timer.unref?.();
  } catch {
    // A kick is an optimization. The tick still runs the job.
  }
}

/** Test hook: forget all kick state. */
export function resetKickForTests(): void {
  globalForKick.__miasdrKick = undefined;
}
