import { describe, expect, it } from "vitest";
import { runTick } from "./tick";
import type { Job } from "./types";

const ok = (name: string, processed = 1): Job => ({
  name,
  run: async () => ({ processed, more: false }),
});

describe("runTick", () => {
  it("runs every job and reports results", async () => {
    const report = await runTick([ok("a", 2), ok("b", 3)]);
    expect(report.jobs).toEqual([
      { name: "a", processed: 2, more: false, durationMs: expect.any(Number) },
      { name: "b", processed: 3, more: false, durationMs: expect.any(Number) },
    ]);
  });

  it("isolates a failing job", async () => {
    const bad: Job = { name: "bad", run: async () => { throw new Error("boom"); } };
    const report = await runTick([bad, ok("good")]);
    expect(report.jobs[0]).toMatchObject({ name: "bad", error: "boom", more: true });
    expect(report.jobs[1]).toMatchObject({ name: "good", processed: 1 });
  });

  it("skips remaining jobs once the budget is spent", async () => {
    const report = await runTick([ok("a"), ok("b")], 0);
    expect(report.jobs.map((j) => j.processed)).toEqual([0, 0]);
    expect(report.jobs.every((j) => j.more)).toBe(true);
  });
});
