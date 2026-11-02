import { beforeAll, expect, it, vi } from "vitest";
import { describeDb, useTestEnv } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/** A file of its own: `env()` caches the first read, so the switch must be set before the route module loads. */
describeDb("/api/mcp with MCP_ENABLED=false", () => {
  useTestEnv({ MCP_ENABLED: "false" });
  let POST: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    ({ POST } = await import("./route"));
  });

  it("answers 404 before it reads any token", async () => {
    const result = await callMcp(POST, { era: "modern", token: "anything", method: "server/discover" });
    expect(result.status).toBe(404);
    expect(result.headers.get("www-authenticate")).toBeNull();
  });
});
