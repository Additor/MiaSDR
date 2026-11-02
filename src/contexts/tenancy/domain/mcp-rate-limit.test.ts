import { describe, expect, it } from "vitest";
import { MCP_RATE_LIMITS, rateRetryAfterSeconds, rateWindowStart } from "./mcp-rate-limit";

describe("MCP rate windows", () => {
  it("starts each window on the minute and counts the seconds left in it", () => {
    const now = new Date("2026-10-30T12:34:15.200Z");
    expect(rateWindowStart(now).toISOString()).toBe("2026-10-30T12:34:00.000Z");
    expect(rateRetryAfterSeconds(now)).toBe(45);
    expect(rateRetryAfterSeconds(new Date("2026-10-30T12:34:59.999Z"))).toBe(1);
    expect(rateRetryAfterSeconds(new Date("2026-10-30T12:35:00.000Z"))).toBe(60);
  });

  it("starts an hourly bucket's window on the hour", () => {
    const now = new Date("2026-10-30T12:34:15.200Z");
    const { windowMs } = MCP_RATE_LIMITS.ai;
    expect(rateWindowStart(now, windowMs).toISOString()).toBe("2026-10-30T12:00:00.000Z");
    expect(rateRetryAfterSeconds(now, windowMs)).toBe(25 * 60 + 45);
  });
});
