import { describe, expect, it } from "vitest";
import { decideRate, LocalRateGate, RATE_WINDOW_MS } from "./enrichment-rate-limit";

describe("provider rate limit", () => {
  const now = 1_000_000;

  it("allows everything when no limit is set", () => {
    expect(decideRate(Array(500).fill(now), now, null)).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("allows calls below the limit and blocks at it", () => {
    expect(decideRate([now - 1000], now, 2).allowed).toBe(true);
    const blocked = decideRate([now - 40_000, now - 1000], now, 2);
    expect(blocked.allowed).toBe(false);
    // The oldest call leaves the window in 20 seconds.
    expect(blocked.retryAfterMs).toBe(20_000);
  });

  it("ignores calls outside the window", () => {
    expect(decideRate([now - RATE_WINDOW_MS - 1, now - RATE_WINDOW_MS - 5], now, 1).allowed).toBe(true);
  });

  it("waits for the slot that frees first when far over the limit", () => {
    const calls = [now - 50_000, now - 40_000, now - 30_000, now - 20_000];
    // Limit 2: the second newest call (30 s old) must leave before a new call fits.
    expect(decideRate(calls, now, 2).retryAfterMs).toBe(30_000);
  });

  it("never asks for less than a second", () => {
    expect(decideRate([now - RATE_WINDOW_MS + 5], now, 1).retryAfterMs).toBe(1000);
  });

  it("the local gate covers calls in flight that the store has not seen yet", () => {
    const gate = new LocalRateGate();
    expect(gate.tryTake("org:p", [], now, 2).allowed).toBe(true);
    expect(gate.tryTake("org:p", [], now + 1, 2).allowed).toBe(true);
    expect(gate.tryTake("org:p", [], now + 2, 2).allowed).toBe(false);
    // Another provider has its own budget.
    expect(gate.tryTake("org:q", [], now + 2, 2).allowed).toBe(true);
  });

  it("holds every call to a provider until the vendor's wait is over", () => {
    const gate = new LocalRateGate();
    gate.hold("org:p", now + 30_000);
    expect(gate.tryTake("org:p", [], now, null)).toEqual({ allowed: false, retryAfterMs: 30_000 });
    expect(gate.tryTake("org:q", [], now, null).allowed).toBe(true);
    // A shorter hold does not cut a longer one.
    gate.hold("org:p", now + 5_000);
    expect(gate.tryTake("org:p", [], now + 10_000, null).allowed).toBe(false);
    expect(gate.tryTake("org:p", [], now + 30_000, null).allowed).toBe(true);
  });

  it("the local gate does not count a call twice once the store shows it", () => {
    const gate = new LocalRateGate();
    gate.tryTake("org:p", [], now, 3);
    gate.tryTake("org:p", [now], now + 1, 3);
    expect(gate.tryTake("org:p", [now, now + 1], now + 2, 3).allowed).toBe(true);
    expect(gate.tryTake("org:p", [now, now + 1, now + 2], now + 3, 3).allowed).toBe(false);
  });
});
