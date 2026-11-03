import { describe, expect, it } from "vitest";
import { HEARTBEAT_STALE_MS, schedulerHealthOf, schedulerProblem } from "./heartbeat";

const now = new Date("2026-11-03T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("scheduler health", () => {
  it("reads a recent tick as running, even while it runs", () => {
    expect(schedulerHealthOf({ startedAt: ago(60_000), finishedAt: ago(30_000) }, now)).toEqual({ state: "running" });
    expect(schedulerHealthOf({ startedAt: ago(60_000), finishedAt: null }, now)).toEqual({ state: "running" });
  });

  it("tells a stopped scheduler from a hung tick", () => {
    expect(schedulerHealthOf({ startedAt: ago(HEARTBEAT_STALE_MS + 1), finishedAt: ago(HEARTBEAT_STALE_MS) }, now).state).toBe("stopped");
    expect(schedulerHealthOf({ startedAt: ago(HEARTBEAT_STALE_MS + 1), finishedAt: null }, now).state).toBe("hung");
  });

  it("raises no alarm on a fresh install that has not ticked yet", () => {
    expect(schedulerProblem(schedulerHealthOf(null, now))).toBeNull();
    expect(schedulerProblem({ state: "running" })).toBeNull();
    expect(schedulerProblem({ state: "stopped", since: now })).toContain("stopped running");
    expect(schedulerProblem({ state: "hung", since: now })).toContain("has not finished");
  });
});
