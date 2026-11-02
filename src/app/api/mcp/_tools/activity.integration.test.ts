import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { callMcp } from "@/test-support/mcp-client";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";
import type { Actor } from "@/shared/errors";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

describeDb("MCP agent activity", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let POST: (request: Request) => Promise<Response>;
  let calls: typeof import("@/contexts/tenancy/application/mcp-tool-calls");
  let deps: import("@/contexts/tenancy/application/mcp-tool-calls").McpToolCallDeps;
  const orgs: TestOrg[] = [];
  const users: string[] = [];
  let caller: McpCaller;
  let owner: Actor;
  let member: Actor;

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    calls = await import("@/contexts/tenancy/application/mcp-tool-calls");
    deps = (await import("@/contexts/tenancy/infrastructure/mcp-composition")).mcpToolCallDeps();
    orgs.push(await createTestOrg(sql, "Activity"));
    const [org] = orgs;
    await enableMcp(sql, org.organizationId);
    const [{ id: userId }] = await sql<{ id: string }[]>`insert into users (name, email) values ('Mo Member', ${`mo-${randomBytes(4).toString("hex")}@mcp.test`}) returning id`;
    users.push(userId);
    await sql`insert into members (organization_id, user_id, role) values (${org.organizationId}, ${userId}, 'member')`;
    owner = { userId: org.userId, organizationId: org.organizationId, role: "owner" };
    member = { userId, organizationId: org.organizationId, role: "member" };
    caller = await mcpCaller(sql, POST, org);
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs, users);
    } finally {
      await sql.end();
    }
  });

  it("logs each call with its ids and outcome, never its text, and shows it to owners and admins only", async () => {
    await caller.tool("get_workspace", {});
    const missing = crypto.randomUUID();
    await caller.tool("get_conversation", { conversationId: missing });
    await caller.tool("search_people", { query: "secret words" });

    const { calls: logged, more } = await calls.listMcpToolCalls(deps, owner, { writesOnly: false, before: null });
    expect(more).toBe(false);
    expect(logged.map((c) => c.tool)).toEqual(["search_people", "get_conversation", "get_workspace"]);
    expect(logged[1]).toMatchObject({ kind: "read", target: { conversationId: missing }, errorCode: "not_found", tokenName: "Test agent" });
    expect(logged[0]).toMatchObject({ target: {}, errorCode: null });
    expect(JSON.stringify(logged)).not.toContain("secret words");

    expect((await calls.listMcpToolCalls(deps, owner, { writesOnly: true, before: null })).calls).toEqual([]);
    const older = await calls.listMcpToolCalls(deps, owner, { writesOnly: false, before: logged[0].id });
    expect(older.calls.map((c) => c.tool)).toEqual(["get_conversation", "get_workspace"]);
    await expect(calls.listMcpToolCalls(deps, member, { writesOnly: false, before: null })).rejects.toThrow(/owner or admin/);
  });

  it("logs a call to a tool the token cannot see, a call with bad input, and values Postgres would refuse", async () => {
    const agent = await mcpCaller(sql, POST, orgs[0]);
    const call = (params: Record<string, unknown>) => callMcp(POST, { era: "modern", token: agent.token, method: "tools/call", params });
    await call({ name: "send_reply", arguments: { conversationId: "c" } });
    await call({ name: "get_person", arguments: { personId: 7 } });
    await agent.tool("get_person", { personId: "nul\u0000-\ud83d" }).catch(() => null);
    const rows = await sql<{ tool: string; error_code: string; target: Record<string, string> }[]>`select tool, error_code, target from mcp_tool_calls where token_id = ${agent.tokenId} and tool in ('send_reply', 'get_person') order by created_at`;
    expect(rows.slice(0, 2)).toMatchObject([{ tool: "send_reply", error_code: "unknown_tool" }, { tool: "get_person", error_code: "invalid_input" }]);
    expect(rows[2]?.target.personId).not.toContain("\u0000");
  });
});
