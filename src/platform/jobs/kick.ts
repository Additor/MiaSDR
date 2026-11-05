/**
 * Post-response kick. A request that queues work (a grid run, a retry, an auto-run after an edit) calls `kickJob`
 * so this process runs the job at once instead of waiting for the next scheduler tick.
 *
 * - The kick never runs inside the request: it only schedules a timer and returns. It never throws.
 * - At most one kicked pass runs at a time per lane and process. A kick that arrives meanwhile is remembered and
 *   served by one follow-up pass, so work queued after the pass last claimed is not missed.
 * - A pass that reports `more: true` runs again right away until the queue is empty.
 * - Other instances and a process without an embedded scheduler have no runner and ignore the kick; the tick picks the work up.
 *
 * State lives on `globalThis` because Next bundles route handlers and `instrumentation.ts` separately, and both must see the same runner.
 */
export type KickRunner = (jobNames: string[]) => Promise<{ again: string[] }>;

/** Pause between the kick and the pass. It lets the response that triggered the kick leave first. */
export const KICK_DELAY_MS = 25;

const DEFAULT_LANE = "default";

interface Lane {
  pending: Set<string>;
  scheduled: boolean;
  running: boolean;
}

interface KickState {
  runner: KickRunner | null;
  lanes: Map<string, Lane>;
}

const globalForKick = globalThis as unknown as { __miasdrKick?: KickState };
const state = (): KickState => (globalForKick.__miasdrKick ??= { runner: null, lanes: new Map() });

function laneOf(s: KickState, name: string): Lane {
  let lane = s.lanes.get(name);
  if (!lane) {
    lane = { pending: new Set(), scheduled: false, running: false };
    s.lanes.set(name, lane);
  }
  return lane;
}

/** The embedded scheduler registers its runner on start and clears it on stop. */
export function setKickRunner(runner: KickRunner | null): void {
  const s = state();
  s.runner = runner;
  if (!runner) for (const lane of s.lanes.values()) lane.pending.clear();
}

async function drain(s: KickState, lane: Lane): Promise<void> {
  lane.scheduled = false;
  lane.running = true;
  try {
    while (s.runner && lane.pending.size > 0) {
      const names = [...lane.pending];
      lane.pending.clear();
      try {
        const { again } = await s.runner(names);
        for (const name of again) lane.pending.add(name);
      } catch (error) {
        console.error(`[jobs] ${JSON.stringify({ event: "kick.failed", jobs: names, error: error instanceof Error ? error.message : String(error) })}`);
      }
    }
  } finally {
    lane.running = false;
  }
}

/**
 * Asks this process to run `jobName` soon. Safe to call from a request: it returns at once and never throws. A job
 * whose passes take long names its own `laneName`, so its model calls do not hold up the jobs on the default lane.
 */
export function kickJob(jobName: string, laneName = DEFAULT_LANE): void {
  try {
    const s = state();
    if (!s.runner) return;
    const lane = laneOf(s, laneName);
    lane.pending.add(jobName);
    if (lane.running || lane.scheduled) return;
    lane.scheduled = true;
    const timer = setTimeout(() => void drain(s, lane), KICK_DELAY_MS);
    timer.unref?.();
  } catch {
    // A kick is an optimization. The tick still runs the job.
  }
}

/** Test hook: forget all kick state. */
export function resetKickForTests(): void {
  globalForKick.__miasdrKick = undefined;
}
