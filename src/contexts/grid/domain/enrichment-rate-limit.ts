/**
 * Per-provider call budget. The store counts the provider's calls in the last window
 * (from `grid_cell_runs`, so every worker sees the same numbers); this decides.
 */

export const RATE_WINDOW_MS = 60_000;

export interface RateDecision {
  allowed: boolean;
  /** Milliseconds until the oldest counted call leaves the window. 0 when allowed. */
  retryAfterMs: number;
}

/** `callTimes` are the epoch ms of the calls inside the window, in any order. A null limit means unlimited. */
export function decideRate(callTimes: readonly number[], now: number, limitPerMin: number | null, windowMs = RATE_WINDOW_MS): RateDecision {
  if (limitPerMin === null) return { allowed: true, retryAfterMs: 0 };
  const live = callTimes.filter((t) => t > now - windowMs).sort((a, b) => a - b);
  if (live.length < limitPerMin) return { allowed: true, retryAfterMs: 0 };
  // The slot that frees first is the one `limit` calls back from the newest.
  const blocking = live[live.length - limitPerMin];
  return { allowed: false, retryAfterMs: Math.max(1000, blocking + windowMs - now) };
}

/** In-process limiter for one worker, so concurrent cells of one tick do not all see the same stale count. */
export class LocalRateGate {
  private readonly calls = new Map<string, number[]>();

  /** Reserves a slot when the combined count allows it. `recent` are the store's counted call times. */
  tryTake(key: string, recent: readonly number[], now: number, limitPerMin: number | null): RateDecision {
    const own = (this.calls.get(key) ?? []).filter((t) => t > now - RATE_WINDOW_MS);
    // A call this worker made shows up in the store count once its run row is written. Taking the longer of the two
    // views counts it once in both states, so in-flight calls are covered and finished ones are not counted twice.
    const view = own.length > recent.length ? own : [...recent];
    const decision = decideRate(view, now, limitPerMin);
    if (decision.allowed) {
      own.push(now);
    }
    this.calls.set(key, own);
    return decision;
  }
}
