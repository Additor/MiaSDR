import { describe, expect, it } from "vitest";
import { runWaterfall, stepId, type StepExecution, type WaterfallStep } from "./enrichment-waterfall";

const a: WaterfallStep = { providerKey: "a", actionKey: "find" };
const b: WaterfallStep = { providerKey: "b", actionKey: "find" };
const c: WaterfallStep = { providerKey: "c", actionKey: "find" };

const hit = (email: string, costCents = 1): StepExecution => ({ kind: "result", outcome: "hit", primary: email, outputs: { email }, costCents });
const miss = (costCents = 1): StepExecution => ({ kind: "result", outcome: "miss", primary: null, outputs: {}, costCents });

function scripted(answers: Record<string, StepExecution>) {
  const asked: string[] = [];
  return { asked, execute: async (step: WaterfallStep) => (asked.push(stepId(step)), answers[stepId(step)]) };
}

describe("waterfall", () => {
  it("stops at the first hit and never asks later steps", async () => {
    const run = scripted({ "a/find": miss(), "b/find": hit("x@acme.test", 2), "c/find": hit("never@acme.test") });
    const result = await runWaterfall([a, b, c], run.execute, { estimate: () => 1 });
    expect(result.status).toBe("hit");
    expect(run.asked).toEqual(["a/find", "b/find"]);
    if (result.status !== "hit") throw new Error("unreachable");
    expect(result.winnerStep).toEqual(b);
    expect(result.spentCents).toBe(3);
    expect(result.attempts.map((x) => x.outcome)).toEqual(["miss", "hit"]);
  });

  it("returns a miss when every step misses, and remembers them", async () => {
    const run = scripted({ "a/find": miss(), "b/find": miss() });
    const result = await runWaterfall([a, b], run.execute, { estimate: () => 1 });
    expect(result).toMatchObject({ status: "miss", spentCents: 2, missed: ["a/find", "b/find"] });
  });

  it("keeps the first miss that carried a verdict, so a paid answer is not lost", async () => {
    const verdict = (status: string): StepExecution => ({ kind: "result", outcome: "miss", primary: status, outputs: { status }, costCents: 1 });
    const run = scripted({ "a/find": miss(), "b/find": verdict("catch_all"), "c/find": verdict("unknown") });
    const result = await runWaterfall([a, b, c], run.execute, { estimate: () => 1 });
    expect(result).toMatchObject({ status: "miss", fallback: { step: b, primary: "catch_all", outputs: { status: "catch_all" } } });
    expect(run.asked).toEqual(["a/find", "b/find", "c/find"]);
    const plain = await runWaterfall([a], scripted({ "a/find": miss() }).execute, { estimate: () => 1 });
    expect(plain).not.toHaveProperty("fallback");
  });

  it("moves past a permanent error to the next provider", async () => {
    const run = scripted({ "a/find": { kind: "error", transient: false, message: "bad key" }, "b/find": hit("y@acme.test") });
    const result = await runWaterfall([a, b], run.execute, { estimate: () => 0 });
    expect(result.status).toBe("hit");
    expect(result.attempts[0]).toMatchObject({ outcome: "error", detail: "bad key" });
  });

  it("asks for a retry when nothing hit and a step failed transiently, keeping the misses", async () => {
    const run = scripted({ "a/find": miss(), "b/find": { kind: "error", transient: true, message: "502" } });
    const result = await runWaterfall([a, b], run.execute, { estimate: () => 0 });
    expect(result).toMatchObject({ status: "retry", missed: ["a/find"] });
  });

  it("does not ask a step that already missed on an earlier try", async () => {
    const run = scripted({ "b/find": hit("z@acme.test") });
    const result = await runWaterfall([a, b], run.execute, { estimate: () => 0, alreadyMissed: new Set(["a/find"]) });
    expect(result.status).toBe("hit");
    expect(run.asked).toEqual(["b/find"]);
  });

  it("skips a rate-limited provider, uses the next, and retries only when nothing hit", async () => {
    const run = scripted({ "a/find": { kind: "rate_limited", retryAfterMs: 20_000 }, "b/find": miss() });
    const result = await runWaterfall([a, b], run.execute, { estimate: () => 0 });
    expect(result).toMatchObject({ status: "retry", retryAfterMs: 20_000, missed: ["b/find"] });
    const second = scripted({ "a/find": { kind: "rate_limited", retryAfterMs: 20_000 }, "b/find": hit("q@acme.test") });
    expect((await runWaterfall([a, b], second.execute, { estimate: () => 0 })).status).toBe("hit");
  });

  it("skips a step whose worst case would pass the per-cell cost cap", async () => {
    const run = scripted({ "a/find": miss(5), "b/find": hit("n@acme.test", 9), "c/find": hit("m@acme.test", 1) });
    const estimates: Record<string, number> = { "a/find": 5, "b/find": 9, "c/find": 1 };
    const result = await runWaterfall([a, b, c], run.execute, { estimate: (s) => estimates[stepId(s)], maxCostCents: 8 });
    expect(run.asked).toEqual(["a/find", "c/find"]);
    expect(result.attempts.find((x) => x.step === b)).toMatchObject({ outcome: "skipped" });
    expect(result.status).toBe("hit");
  });

  it("fails permanently when every step is unavailable or rejected", async () => {
    const run = scripted({ "a/find": { kind: "unavailable", message: "Provider \"a\" is switched off." }, "b/find": { kind: "error", transient: false, message: "401" } });
    const result = await runWaterfall([a, b], run.execute, { estimate: () => 0 });
    expect(result).toMatchObject({ status: "failed", message: "Provider \"a\" is switched off." });
  });

  it("passes a transient error's retry-after to the retry", async () => {
    const run = scripted({ "a/find": { kind: "error", transient: true, message: "limit", retryAfterMs: 45_000 } });
    const result = await runWaterfall([a], run.execute, { estimate: () => 1 });
    expect(result).toMatchObject({ status: "retry", retryAfterMs: 45_000 });
  });
});
