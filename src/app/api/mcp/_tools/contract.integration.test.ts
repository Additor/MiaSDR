import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { callMcp, legacyInitialize } from "@/test-support/mcp-client";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * The definitions every agent loads before its first call: names, descriptions, annotations and schemas. A change to
 * any of them shows in the snapshot, so it is reviewed as a contract change. The budget is the plan's 6,500 tokens,
 * counted as one token per three characters, more tokens than a tokenizer finds for JSON, so it errs toward failing.
 */
const DEFINITION_TOKEN_BUDGET = 6_500;
const CHARS_PER_TOKEN = 3;

interface ListedTool {
  name: string;
  description: string;
  annotations: Record<string, unknown>;
  inputSchema: { type: string };
  outputSchema?: { type: string };
}

describeDb("MCP contract", () => {
  useTestEnv();
  const sql = testSql({ max: 2 });
  let POST: (request: Request) => Promise<Response>;
  const orgs: TestOrg[] = [];
  let caller: McpCaller;
  let tools: ListedTool[];

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    orgs.push(await createTestOrg(sql, "Contract"));
    await enableMcp(sql, orgs[0].organizationId);
    caller = await mcpCaller(sql, POST, orgs[0]);
    tools = ((await callMcp(POST, { era: "modern", token: caller.token, method: "tools/list" })).body as { result: { tools: ListedTool[] } }).result.tools;
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("gives the server instructions to a client of either era", async () => {
    const { SERVER_INSTRUCTIONS } = await import("./instructions");
    const modern = await callMcp(POST, { era: "modern", token: caller.token, method: "server/discover" });
    expect(JSON.stringify(modern.body)).toContain(JSON.stringify(SERVER_INSTRUCTIONS).slice(1, 60));
    const legacy = await callMcp(POST, { era: "legacy", token: caller.token, method: "initialize", params: legacyInitialize });
    expect((legacy.body as { result: { instructions: string } }).result.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).toMatchSnapshot();
  });

  it("lists the eleven read tools by name, each read-only with object schemas", () => {
    expect(tools.map((t) => t.name)).toEqual([...tools.map((t) => t.name)].sort());
    expect(tools).toHaveLength(11);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.outputSchema?.type, tool.name).toBe("object");
    }
  });

  it("keeps the definitions within the token budget and unchanged unless reviewed", () => {
    const tokens = Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN);
    expect(tokens).toBeLessThanOrEqual(DEFINITION_TOKEN_BUDGET);
    expect(tools).toMatchSnapshot();
  });
});
