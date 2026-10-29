import { describe, expect, it } from "vitest";
import { LocalRateGate } from "../domain/enrichment-rate-limit";
import { MAX_JOBS_PER_TICK } from "../domain/enrichment-run-limits";
import type { CellJob } from "./enrichment-ports";
import { createGridRunJob, type WorkerDeps } from "./enrichment-worker";

/**
 * Throughput tests on virtual time. The provider sleeps on a fake clock; `drive` advances the clock to the next wake
 * time whenever every task is parked, so a run of thousands of "slow" cells finishes in milliseconds of real time.
 */
class VirtualClock {
  t = Date.UTC(2026, 0, 1);
  private timers: Array<{ at: number; wake: () => void }> = [];
  now = () => new Date(this.t);
  sleep(ms: number): Promise<void> {
    return new Promise((wake) => this.timers.push({ at: this.t + ms, wake }));
  }
  /** Runs the clock until `done()` is true. Fails when everything is parked and nothing is scheduled. */
  async driveUntil(done: () => boolean): Promise<void> {
    for (let guard = 0; guard < 1_000_000; guard++) {
      for (let i = 0; i < 2; i++) await new Promise((r) => setImmediate(r));
      if (done()) return;
      if (this.timers.length === 0) throw new Error("deadlock: no timer is pending and the run has not finished");
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers.shift()!;
      this.t = Math.max(this.t, next.at);
      next.wake();
    }
    throw new Error("clock did not settle");
  }
  async drive<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    const guarded = promise.finally(() => {
      settled = true;
    });
    guarded.catch(() => undefined);
    await this.driveUntil(() => settled);
    return promise;
  }
}

interface MemJob extends CellJob {
  status: "queued" | "running" | "done";
}

/** In-memory queue with the claim rules of the SQL store that matter here: one claim per job, 8 running per organization. */
class MemoryStore {
  jobs: MemJob[] = [];
  written = new Map<string, number>();
  claims = 0;
  limits: number[] = [];
  sweeps: Array<boolean | undefined> = [];
  /** When set, the first claim returns at most this many jobs although more are due (a concurrent claimer held the rest). */
  shortFirstClaim: number | null = null;
  /** The claim with this number (1-based) throws. */
  failClaimAt: number | null = null;
  inFlightAtFailure = -1;
  constructor(private clock: VirtualClock) {}

  add(n: number, organizationId = "org-a", prefix = "c") {
    for (let i = 0; i < n; i++) {
      const id = `${prefix}${this.jobs.length}`;
      this.jobs.push({ id, organizationId, tableId: "t", rowId: id, columnKey: "ai", attempts: 0, maxAttempts: 3, providerState: null, lockedAt: new Date(0), status: "queued" });
    }
  }
  queued = () => this.jobs.filter((j) => j.status === "queued").length;
  done = () => this.jobs.filter((j) => j.status === "done").length;

  private cursor = 0;
  private running = new Map<string, number>();

  async claim(_now: Date, _lease: number, requested: number, _worker?: string, options?: { sweepExhausted?: boolean }) {
    this.claims++;
    this.limits.push(requested);
    this.sweeps.push(options?.sweepExhausted);
    if (this.failClaimAt === this.claims) {
      this.inFlightAtFailure = this.jobs.filter((j) => j.status === "running").length;
      throw new Error("claim failed");
    }
    const limit = this.claims === 1 && this.shortFirstClaim !== null ? Math.min(requested, this.shortFirstClaim) : requested;
    const out: MemJob[] = [];
    for (let i = this.cursor; i < this.jobs.length && out.length < limit; i++) {
      const job = this.jobs[i];
      if (job.status !== "queued") continue;
      if ((this.running.get(job.organizationId) ?? 0) >= 8) continue;
      job.status = "running";
      job.attempts++;
      this.running.set(job.organizationId, (this.running.get(job.organizationId) ?? 0) + 1);
      out.push(job);
    }
    while (this.cursor < this.jobs.length && this.jobs[this.cursor].status !== "queued") this.cursor++;
    return out.map((j) => ({ ...j }));
  }
  private finish(job: CellJob) {
    const own = this.jobs.find((j) => j.id === job.id)!;
    own.status = "done";
    this.running.set(own.organizationId, (this.running.get(own.organizationId) ?? 1) - 1);
  }
  async loadCell(job: CellJob) {
    const column = { key: "ai", type: "ai", dependsOn: ["name"], autoRun: false, id: "col", name: "ai", position: 1, updatedAt: new Date(0), config: { prompt: "Describe {{name}}", outputs: [{ key: "about", type: "text" }], outputColumns: { about: "about" } } };
    return { column, columns: [column], cells: { name: job.rowId }, tableAutoRun: false };
  }
  async succeed(job: CellJob) {
    this.finish(job);
    this.written.set(job.id, (this.written.get(job.id) ?? 0) + 1);
    return true;
  }
  async fail(job: CellJob) {
    this.finish(job);
    return true;
  }
  async retryLater() {
    return true;
  }
  async skip() {
    return true;
  }
  async recentCalls(): Promise<number[]> {
    return [];
  }
  async reusableAnswer() {
    return null;
  }
}

function setup(options: { concurrency?: number; latency?: (cell: string) => number; block?: (cell: string) => Promise<void> | undefined } = {}) {
  const clock = new VirtualClock();
  const store = new MemoryStore(clock);
  const providerCalls = new Map<string, number>();
  const ai = {
    async answer(_org: string, input: { cells: Array<{ key: string; value: string }> }) {
      const cell = input.cells[0].value;
      providerCalls.set(cell, (providerCalls.get(cell) ?? 0) + 1);
      const blocked = options.block?.(cell);
      if (blocked) await blocked;
      await clock.sleep(options.latency?.(cell) ?? 5);
      return { output: { about: `about ${cell}` }, provider: "fake", model: "fake-1" };
    },
  };
  const gate = new LocalRateGate();
  const deps = (workerId: string): WorkerDeps => ({
    store,
    providers: {} as never,
    adapters: {} as never,
    cipher: {} as never,
    ai,
    now: clock.now,
    workerId,
    leaseMs: 5 * 60_000,
    concurrency: options.concurrency ?? 16,
    callTimeoutMs: 30_000,
    gate,
  });
  const pass = (workerId: string, budgetMs: number) => {
    const job = createGridRunJob(deps(workerId));
    return job.run({ deadline: clock.t + budgetMs, now: clock.now });
  };
  return { clock, store, providerCalls, pass };
}

describe("grid.run slot pool", () => {
  it("finishes 1,000 cells inside one tick when a few cells are slow", async () => {
    // Every 16th cell takes 100 ms, the rest 5 ms. A batch waits for its slowest cell: 63 batches x 100 ms = 6.3 s.
    // A slot pool keeps the other slots busy and needs about 0.7 s.
    const { clock, store, pass } = setup({ latency: (cell) => (Number(cell.slice(1)) % 16 === 0 ? 100 : 5) });
    store.add(1000);
    const startedAt = clock.t;
    const result = await clock.drive(pass("w1", 3000));
    expect(result.processed).toBe(1000);
    expect(result.more).toBe(false);
    expect(store.done()).toBe(1000);
    expect(clock.t - startedAt).toBeLessThan(2500);
  });

  it("stops a pass at the per-tick ceiling and reports that more work is queued", async () => {
    const { clock, store, pass } = setup({ latency: () => 1 });
    store.add(MAX_JOBS_PER_TICK + 500);
    const result = await clock.drive(pass("w1", 60_000));
    expect(result.processed).toBe(MAX_JOBS_PER_TICK);
    expect(result.more).toBe(true);
    expect(store.queued()).toBe(500);
  });

  it("does not let a cell that blocks the whole budget hold the other slots", async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    const { clock, store, pass } = setup({ concurrency: 4, block: (cell) => (cell === "c0" ? gateOpen : undefined) });
    store.add(60);
    const run = pass("w1", 50_000);
    // While c0 is parked, the other three slots keep claiming. A batch loop would stop after 3 completions.
    await clock.driveUntil(() => store.done() >= 59);
    expect(store.done()).toBe(59);
    expect(store.jobs[0].status).toBe("running");
    release();
    const result = await clock.drive(run);
    expect(result.processed).toBe(60);
    expect(store.done()).toBe(60);
  });

  it("stops claiming at the deadline, reports more, and a second pass finishes the rest", async () => {
    const { clock, store, providerCalls, pass } = setup({ concurrency: 4, latency: () => 10 });
    store.add(100);
    const first = await clock.drive(pass("w1", 100));
    expect(first.more).toBe(true);
    expect(first.processed).toBeGreaterThan(0);
    expect(first.processed).toBeLessThan(100);
    expect(store.queued()).toBe(100 - first.processed);
    const second = await clock.drive(pass("w1", 60_000));
    expect(second.more).toBe(false);
    expect(store.done()).toBe(100);
    expect([...providerCalls.values()].every((n) => n === 1)).toBe(true);
    expect(providerCalls.size).toBe(100);
  });

  it("runs each cell once when two workers drain one queue at the same time", async () => {
    const { clock, store, providerCalls, pass } = setup({ concurrency: 4, latency: () => 10 });
    store.add(300);
    const [a, b] = await clock.drive(Promise.all([pass("w1", 200), pass("w2", 200)]));
    expect(a.processed + b.processed).toBeLessThan(300);
    await clock.drive(Promise.all([pass("w1", 60_000), pass("w2", 60_000)]));
    expect(store.done()).toBe(300);
    expect(providerCalls.size).toBe(300);
    expect([...providerCalls.values()].every((n) => n === 1)).toBe(true);
    expect([...store.written.values()].every((n) => n === 1)).toBe(true);
  });

  it("ends the pass when the queue is empty without waiting for the budget", async () => {
    const { clock, store, pass } = setup();
    store.add(10);
    const started = clock.t;
    const result = await clock.drive(pass("w1", 50_000));
    expect(result).toMatchObject({ processed: 10, more: false });
    expect(clock.t - started).toBeLessThan(100);
  });

  it("keeps trying to claim while the queue is held back by a running cap, until a slot frees", async () => {
    // The memory store allows 8 running per organization; 16 slots see an empty claim while 8 run.
    const { clock, store, pass } = setup({ concurrency: 16, latency: () => 20 });
    store.add(40);
    const result = await clock.drive(pass("w1", 50_000));
    expect(result.processed).toBe(40);
    expect(store.done()).toBe(40);
  });

  it("does not treat a short claim with due rows left as a dry queue", async () => {
    // A concurrent claimer held the top candidates, so the first claim of 4 returned 1 job. 39 are still due.
    const { clock, store, pass } = setup({ concurrency: 4, latency: () => 50 });
    store.shortFirstClaim = 1;
    store.add(40);
    const run = pass("w1", 50_000);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    // Before any cell finished, the worker already asked again and filled the free slots.
    expect(store.done()).toBe(0);
    expect(store.claims).toBeGreaterThanOrEqual(2);
    expect(store.jobs.filter((j) => j.status === "running")).toHaveLength(4);
    const result = await clock.drive(run);
    expect(result).toMatchObject({ processed: 40, more: false });
    expect(store.done()).toBe(40);
  });

  it("sweeps exhausted jobs on the first claim and after a short claim, not on every refill", async () => {
    const { clock, store, pass } = setup({ concurrency: 4, latency: () => 10 });
    store.add(40);
    await clock.drive(pass("w1", 50_000));
    expect(store.sweeps[0]).toBe(true);
    // Full claims in the middle of the pass skip the sweep; only short claims (the tail) ask for it again.
    const middle = store.sweeps.slice(1, -2);
    expect(middle.length).toBeGreaterThan(2);
    expect(middle.every((s) => s === false)).toBe(true);
  });

  it("refills in batches of two or more while other cells run", async () => {
    const { clock, store, pass } = setup({ concurrency: 4, latency: (cell) => 5 + (Number(cell.slice(1)) % 4) * 3 });
    store.add(60);
    await clock.drive(pass("w1", 50_000));
    expect(store.done()).toBe(60);
    expect(store.limits.every((l) => l >= 2)).toBe(true);
  });

  it("settles every in-flight cell before a failing claim rejects the pass", async () => {
    const { clock, store, pass } = setup({ concurrency: 4, latency: (cell) => (Number(cell.slice(1)) < 2 ? 5 : 200) });
    store.add(40);
    store.failClaimAt = 2;
    const outcome = await clock.drive(pass("w1", 50_000).then(() => "resolved", (e: Error) => e.message));
    expect(outcome).toBe("claim failed");
    expect(store.inFlightAtFailure).toBeGreaterThan(0);
    // The pass rejected only after those cells finished: none is left running, none ran twice.
    expect(store.jobs.filter((j) => j.status === "running")).toHaveLength(0);
    expect([...store.written.values()].every((n) => n === 1)).toBe(true);
    expect(store.done()).toBeGreaterThanOrEqual(store.inFlightAtFailure);
  });
});
