import { describe, expect, it } from "vitest";
import { MCP_BAD_TOKEN_LIMIT } from "@/contexts/tenancy/domain/mcp-rate-limit";
import { BadTokenLimiter, clientIp } from "./bad-token-limiter";

describe("clientIp", () => {
  it("reads the entry the nearest trusted proxy appended", () => {
    expect(clientIp("6.6.6.6, 1.2.3.4", 1)).toBe("1.2.3.4");
    expect(clientIp("6.6.6.6, 1.2.3.4, 10.0.0.2", 2)).toBe("1.2.3.4");
  });

  it("reads nothing without hops, without the header, or when the header is shorter than the hops", () => {
    expect(clientIp("1.2.3.4", undefined)).toBeNull();
    expect(clientIp(null, 1)).toBeNull();
    expect(clientIp("1.2.3.4", 2)).toBeNull();
    expect(clientIp(" , ", 1)).toBeNull();
  });
});

describe("BadTokenLimiter", () => {
  const now = new Date("2026-10-30T12:00:10Z");

  it("lets an IP guess up to the limit in a minute, then answers the seconds left", () => {
    const limiter = new BadTokenLimiter();
    for (let i = 0; i < MCP_BAD_TOKEN_LIMIT; i++) {
      expect(limiter.retryAfter("1.2.3.4", now)).toBeNull();
      limiter.record("1.2.3.4", now);
    }
    expect(limiter.retryAfter("1.2.3.4", now)).toBe(50);
    expect(limiter.retryAfter("5.6.7.8", now)).toBeNull();
    expect(limiter.retryAfter("1.2.3.4", new Date("2026-10-30T12:01:00Z"))).toBeNull();
  });

  it("starts a new count in the next minute", () => {
    const limiter = new BadTokenLimiter();
    for (let i = 0; i < MCP_BAD_TOKEN_LIMIT; i++) limiter.record("1.2.3.4", now);
    const next = new Date("2026-10-30T12:01:05Z");
    limiter.record("1.2.3.4", next);
    expect(limiter.retryAfter("1.2.3.4", next)).toBeNull();
  });
});
