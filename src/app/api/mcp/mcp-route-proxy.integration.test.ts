import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MCP_BAD_TOKEN_LIMIT } from "@/contexts/agent-access/domain/mcp-rate-limit";
import { describeDb, useTestEnv } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** A file of its own: `env()` caches the first read, so TRUST_PROXY_HOPS must be set before the route module loads. */
describeDb("/api/mcp behind one trusted proxy", () => {
  useTestEnv({ TRUST_PROXY_HOPS: "1" });
  let POST: (request: Request) => Promise<Response>;

  const guess = (ip: string, token: string | null = `msdr_pat_${randomBytes(32).toString("base64url")}`) =>
    callMcp(POST, { era: "modern", token, method: "server/discover", headers: { "x-forwarded-for": `198.51.100.1, ${ip}` } });

  beforeAll(async () => {
    ({ POST } = await import("./route"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T12:00:05Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("refuses an IP for the rest of the minute once it fails with well-formed tokens 20 times", async () => {
    for (let i = 0; i < MCP_BAD_TOKEN_LIMIT; i++) expect((await guess("192.0.2.1")).status).toBe(401);
    const refused = await guess("192.0.2.1");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("55");
    // The entry left of the proxy's is the client's own claim and does not count.
    expect((await guess("192.0.2.2")).status).toBe(401);
  });

  it("does not count a missing or malformed token against the IP", async () => {
    for (let i = 0; i < MCP_BAD_TOKEN_LIMIT; i++) {
      expect((await guess("192.0.2.3", null)).status).toBe(401);
      expect((await guess("192.0.2.3", "msdr_pat_short")).status).toBe(401);
    }
    expect((await guess("192.0.2.3")).status).toBe(401);
  });
});
