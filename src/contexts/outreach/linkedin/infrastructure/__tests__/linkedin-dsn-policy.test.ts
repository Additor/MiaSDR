import { afterEach, describe, expect, it, vi } from "vitest";

describe("dsnPolicy loopback", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function policy(provider: string, options?: { allowLoopback?: boolean }) {
    vi.stubEnv("LINKEDIN_PROVIDER", provider);
    vi.stubEnv("DATABASE_URL", "postgres://x:x@localhost:1/x");
    vi.stubEnv("APP_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(40));
    vi.stubEnv("INTEGRATION_CREDENTIALS_KEY", "x".repeat(40));
    vi.stubEnv("UNSUBSCRIBE_SECRET", "x".repeat(40));
    vi.resetModules();
    const { dsnPolicy } = await import("../linkedin-composition");
    const { normalizeDsn } = await import("../../application/linkedin-management");
    return { p: dsnPolicy(options), normalizeDsn };
  }

  it("NODE_ENV=test with the unipile provider still rejects localhost", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const { p, normalizeDsn } = await policy("unipile");
    expect(p.allowLoopback).toBe(false);
    expect(normalizeDsn("localhost:4000", p)).toBeNull();
    expect(normalizeDsn("127.0.0.1:4000", p)).toBeNull();
  });

  it("the fake provider accepts localhost", async () => {
    const { p, normalizeDsn } = await policy("fake");
    expect(normalizeDsn("localhost:4000", p)).toBe("localhost:4000");
  });

  it("an explicit option accepts localhost", async () => {
    const { p, normalizeDsn } = await policy("unipile", { allowLoopback: true });
    expect(normalizeDsn("127.0.0.1:4000", p)).toBe("127.0.0.1:4000");
  });
});
