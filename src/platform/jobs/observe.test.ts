import { describe, expect, it, vi } from "vitest";
import { startEmbeddedScheduler } from "./embedded";
import { createTickObserver, failureSignature } from "./observe";
import type { Job, TickReport } from "./types";

type Line = { level: string; text: string };

function harness(options: { slowTickMs?: number; repeatEveryMs?: number } = {}) {
  const lines: Line[] = [];
  const persisted: Array<{ job: string; message: string; occurrences: number }> = [];
  const clock = { t: 1_000_000 };
  const observer = createTickObserver({
    log: (level, text) => lines.push({ level, text }),
    persist: async (f) => void persisted.push({ job: f.job, message: f.message, occurrences: f.occurrences }),
    now: () => clock.t,
    repeatEveryMs: options.repeatEveryMs ?? 600_000,
    slowTickMs: options.slowTickMs,
  });
  const report = (jobs: TickReport["jobs"], durationMs = 10): TickReport => ({ startedAt: new Date(clock.t).toISOString(), durationMs, jobs });
  const parsed = () => lines.map((l) => ({ level: l.level, ...JSON.parse(l.text.replace("[jobs] ", "")) }));
  return { observer, lines, persisted, clock, report, parsed };
}

const ok = { name: "ok", processed: 1, more: false };
const boom = (message = "boom") => ({ name: "email.send", processed: 0, more: true, error: message });

describe("tick observer", () => {
  it("logs one structured error line per failing job and records it", async () => {
    const h = harness();
    await h.observer.observe(h.report([ok, boom("smtp refused"), { name: "linkedin.run", processed: 0, more: true, error: "gateway 500" }]));
    const lines = h.parsed();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: "error", event: "job.failed", job: "email.send", error: "smtp refused" });
    expect(lines[1]).toMatchObject({ job: "linkedin.run", error: "gateway 500" });
    expect(h.persisted.map((p) => p.job)).toEqual(["email.send", "linkedin.run"]);
  });

  it("writes nothing for a quiet tick", async () => {
    const h = harness();
    await h.observer.observe(h.report([ok, { name: "idle", processed: 0, more: false }]));
    expect(h.lines).toEqual([]);
    expect(h.persisted).toEqual([]);
  });

  it("treats failed items in the job detail as a failure", async () => {
    const h = harness();
    await h.observer.observe(h.report([{ name: "conversations.ai", processed: 3, more: false, detail: { drafted: 3, failed: 2, retry: 1 } }]));
    expect(h.parsed()).toHaveLength(1);
    expect(h.parsed()[0]).toMatchObject({ job: "conversations.ai", error: "2 failed" });
    await h.observer.observe(h.report([{ name: "email.inbox-sync", processed: 0, more: false, detail: { mailboxes_failed: 1 } }]));
    expect(h.parsed().find((l) => l.job === "email.inbox-sync")).toMatchObject({ error: "1 mailboxes failed" });
  });

  it("collapses a repeating failure and reports the skipped ticks on the next line", async () => {
    const h = harness({ repeatEveryMs: 600_000 });
    for (let i = 0; i < 5; i++) {
      await h.observer.observe(h.report([boom("db timeout after 5000 ms")]));
      h.clock.t += 60_000;
    }
    expect(h.lines).toHaveLength(1);
    expect(h.persisted).toHaveLength(1);
    h.clock.t += 600_000;
    await h.observer.observe(h.report([boom("db timeout after 7000 ms")]));
    const lines = h.parsed();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ repeatedSinceLastLine: 4, occurrences: 6 });
    expect(h.persisted[1]).toMatchObject({ occurrences: 6 });
  });

  it("logs a different error at once", async () => {
    const h = harness();
    await h.observer.observe(h.report([boom("first fault")]));
    await h.observer.observe(h.report([boom("second fault")]));
    expect(h.lines).toHaveLength(2);
  });

  it("logs a recovery once and starts a new series after it", async () => {
    const h = harness();
    await h.observer.observe(h.report([boom()]));
    await h.observer.observe(h.report([{ name: "email.send", processed: 2, more: false }]));
    expect(h.parsed().map((l) => l.event)).toEqual(["job.failed", "job.recovered"]);
    await h.observer.observe(h.report([boom()]));
    expect(h.parsed().map((l) => l.event)).toEqual(["job.failed", "job.recovered", "job.failed"]);
  });

  it("does not call a job recovered when the budget skipped it", async () => {
    const h = harness();
    await h.observer.observe(h.report([boom()]));
    await h.observer.observe(h.report([{ name: "email.send", processed: 0, more: true }]));
    expect(h.parsed().map((l) => l.event)).toEqual(["job.failed"]);
  });

  it("logs a slow tick once per window with the slowest jobs", async () => {
    const h = harness({ slowTickMs: 1000 });
    const slowReport = h.report([{ ...ok, name: "a", durationMs: 100 }, { ...ok, name: "b", durationMs: 5000 }], 6000);
    await h.observer.observe(slowReport);
    await h.observer.observe(slowReport);
    const lines = h.parsed();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", event: "tick.slow", durationMs: 6000 });
    expect(lines[0].slowest[0]).toEqual({ job: "b", durationMs: 5000 });
    await h.observer.observe(h.report([ok], 10));
    expect(h.lines).toHaveLength(1);
  });

  it("survives a failing failure record", async () => {
    const lines: Line[] = [];
    const observer = createTickObserver({ log: (level, text) => lines.push({ level, text }), persist: async () => { throw new Error("db down"); } });
    await expect(observer.observe({ startedAt: "x", durationMs: 1, jobs: [boom()] })).resolves.toBeUndefined();
    expect(lines.map((l) => l.level)).toEqual(["error", "warn"]);
  });
});

describe("failureSignature", () => {
  it("removes numbers and ids so repeats match", () => {
    expect(failureSignature("job 123e4567-e89b-12d3-a456-426614174000 timed out after 500 ms")).toBe(failureSignature("job 00000000-0000-0000-0000-000000000000 timed out after 9 ms"));
  });
});

describe("embedded scheduler", () => {
  it("hands every tick report, including a thrown job error, to the observer", async () => {
    vi.useFakeTimers();
    try {
      const bad: Job = { name: "bad", run: async () => { throw new Error("kaput"); } };
      const reports: TickReport[] = [];
      const stop = startEmbeddedScheduler([bad], 1000, async (r) => void reports.push(r));
      await vi.advanceTimersByTimeAsync(1000);
      stop();
      expect(reports).toHaveLength(1);
      expect(reports[0].jobs[0]).toMatchObject({ name: "bad", error: "kaput" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps ticking when the observer throws", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let calls = 0;
      const stop = startEmbeddedScheduler([{ name: "a", run: async () => ({ processed: 0, more: false }) }], 1000, async () => {
        calls += 1;
        throw new Error("observer broke");
      });
      await vi.advanceTimersByTimeAsync(2000);
      stop();
      expect(calls).toBe(2);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
