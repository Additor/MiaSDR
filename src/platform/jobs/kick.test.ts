import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedScheduler } from "./embedded";
import { KICK_DELAY_MS, kickJob, resetKickForTests, setKickRunner } from "./kick";
import type { Job, TickReport } from "./types";

const TICK_MS = 60_000;

/** Fake timers also fake `Date`, so the injected clock below is the vitest clock. */
describe("kickJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetKickForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetKickForTests();
  });

  const job = (name: string, onRun: () => Promise<{ processed: number; more: boolean }>): Job => ({ name, run: onRun });

  it("starts a pass between the enqueue and the tick, without waiting for the tick", async () => {
    const ranAt: number[] = [];
    const grid = job("grid.run", async () => {
      ranAt.push(Date.now());
      return { processed: 1, more: false };
    });
    const reports: TickReport[] = [];
    const stop = startEmbeddedScheduler([grid], TICK_MS, async (r) => void reports.push(r));
    const enqueuedAt = Date.now();
    await vi.advanceTimersByTimeAsync(10_000);
    kickJob("grid.run");
    await vi.advanceTimersByTimeAsync(KICK_DELAY_MS + 5);
    expect(ranAt).toHaveLength(1);
    expect(ranAt[0] - enqueuedAt).toBeLessThan(TICK_MS / 2);
    expect(ranAt[0] - (enqueuedAt + 10_000)).toBeLessThanOrEqual(KICK_DELAY_MS + 5);
    // The tick at 60 s is a separate pass.
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(ranAt.length).toBe(2);
    expect(reports.length).toBe(2);
    stop();
  });

  it("does nothing inside the caller: the pass starts on a later timer, never synchronously", async () => {
    const run = vi.fn(async () => ({ processed: 0, more: false }));
    const stop = startEmbeddedScheduler([job("grid.run", run)], TICK_MS, async () => undefined);
    kickJob("grid.run");
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KICK_DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it("runs at most one kicked pass at a time and serves kicks that arrive meanwhile with one follow-up pass", async () => {
    let concurrent = 0;
    let peak = 0;
    let release!: () => void;
    let first = true;
    const run = vi.fn(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      if (first) {
        first = false;
        await new Promise<void>((r) => (release = r));
      }
      concurrent--;
      return { processed: 1, more: false };
    });
    const stop = startEmbeddedScheduler([job("grid.run", run)], TICK_MS, async () => undefined);
    kickJob("grid.run");
    await vi.advanceTimersByTimeAsync(KICK_DELAY_MS + 1);
    expect(run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i++) kickJob("grid.run");
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(KICK_DELAY_MS + 100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    stop();
  });

  it("runs again at once while the job reports more work, then stops", async () => {
    let left = 3;
    const run = vi.fn(async () => {
      left--;
      return { processed: 5, more: left > 0 };
    });
    const stop = startEmbeddedScheduler([job("grid.run", run)], TICK_MS, async () => undefined);
    kickJob("grid.run");
    await vi.advanceTimersByTimeAsync(KICK_DELAY_MS + 100);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it("does not loop on a job that reports more but processed nothing, or one that threw", async () => {
    const idle = vi.fn(async () => ({ processed: 0, more: true }));
    const broken = vi.fn(async () => {
      throw new Error("boom");
    });
    const stop = startEmbeddedScheduler([job("idle", idle), job("broken", broken)], TICK_MS, async () => undefined);
    kickJob("idle");
    kickJob("broken");
    await vi.advanceTimersByTimeAsync(KICK_DELAY_MS + 500);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(broken).toHaveBeenCalledTimes(1);
    stop();
  });

  it("never throws into the caller when the runner or the observer fails, and keeps working afterwards", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setKickRunner(async () => {
      throw new Error("runner down");
    });
    expect(() => kickJob("grid.run")).not.toThrow();
    await vi.advanceTimersByTimeAsync(KICK_DELAY_MS + 10);
    expect(error).toHaveBeenCalled();

    const run = vi.fn(async () => ({ processed: 1, more: false }));
    const stop = startEmbeddedScheduler([job("grid.run", run)], TICK_MS, async () => {
      throw new Error("observer down");
    });
    kickJob("grid.run");
    await vi.advanceTimersByTimeAsync(KICK_DELAY_MS + 10);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
    error.mockRestore();
  });

  it("is a no-op without an embedded scheduler, and after it stops", async () => {
    expect(() => kickJob("grid.run")).not.toThrow();
    const run = vi.fn(async () => ({ processed: 1, more: false }));
    const stop = startEmbeddedScheduler([job("grid.run", run)], TICK_MS, async () => undefined);
    stop();
    kickJob("grid.run");
    await vi.advanceTimersByTimeAsync(KICK_DELAY_MS + 10);
    expect(run).not.toHaveBeenCalled();
  });
});
