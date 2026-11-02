import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { callMcp, legacyInitialize } from "@/test-support/mcp-client";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * The definitions every agent loads before its first call: names, descriptions, annotations and schemas. A change to
 * any of them shows in the snapshot, so it is reviewed as a contract change. The budget is 6,500 tokens,
 * counted as one token per three characters, more tokens than a tokenizer finds for JSON, so it errs toward failing.
 */
const DEFINITION_TOKEN_BUDGET = 6_500;
/** A write token loads the eight write tools too. Measured at 7,916 when they shipped. */
const WRITE_DEFINITION_TOKEN_BUDGET = 8_500;
/** A send token with agent campaigns on loads three more: send_reply, preview_campaign_launch and launch_campaign. */
const SEND_DEFINITION_TOKEN_BUDGET = 10_000;
const CHARS_PER_TOKEN = 3;

/**
 * Code names an agent must not learn from the definitions: the product says follow-ups, reply handling and AI picks.
 * Identifiers in backticks (`recordId`) and tool names are exempt.
 */
const CODE_NAMES = /\b(sequences?|records?|classifications?)\b/i;
const prose = (text: string) => text.replace(/`[^`]*`/g, "").replace(/\b[a-z]+(?:_[a-z]+)+\b/g, "");

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
  let writer: McpCaller;
  let tools: ListedTool[];
  let writeTools: ListedTool[];
  let sendTools: ListedTool[];

  beforeAll(async () => {
    ({ POST } = await import("../route"));
    orgs.push(await createTestOrg(sql, "Contract"));
    await enableMcp(sql, orgs[0].organizationId);
    caller = await mcpCaller(sql, POST, orgs[0]);
    writer = await mcpCaller(sql, POST, orgs[0], ["mcp:read", "mcp:write"]);
    const list = async (token: string) => ((await callMcp(POST, { era: "modern", token, method: "tools/list" })).body as { result: { tools: ListedTool[] } }).result.tools;
    tools = await list(caller.token);
    writeTools = await list(writer.token);
    await sql`update channel_settings set values = values || ${sql.json({ agentSendMode: "replies_and_campaigns", agentSendEpoch: 0 })} where organization_id = ${orgs[0].organizationId} and channel = 'mcp'`;
    sendTools = await list((await mcpCaller(sql, POST, orgs[0], ["mcp:read", "mcp:write", "mcp:send"])).token);
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

  it("links the two cards from their tools, serves them, and never builds a page from answer text", async () => {
    const { CARDS, DRAFT_CARD_URI } = await import("./cards");
    const { callMcp } = await import("@/test-support/mcp-client");
    const draftTool = writeTools.find((t) => t.name === "write_reply_draft") as ListedTool & { _meta?: { ui?: { resourceUri?: string } } };
    expect(draftTool._meta?.ui?.resourceUri).toBe(DRAFT_CARD_URI);
    expect(tools.every((t) => !("_meta" in t))).toBe(true);
    for (const card of Object.values(CARDS)) expect(card.html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);

    const read = await callMcp(POST, { era: "modern", token: writer.token, method: "resources/read", params: { uri: DRAFT_CARD_URI } });
    expect((read.body as { result: { contents: Array<{ mimeType: string; text: string }> } }).result.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app", text: expect.stringContaining("<!doctype html>") });
    // A read-only token has no tool that names this card, so it has no card either.
    const refused = await callMcp(POST, { era: "modern", token: caller.token, method: "resources/read", params: { uri: DRAFT_CARD_URI } });
    expect((refused.body as { error?: unknown }).error).toBeDefined();
  });

  it("keeps code names out of the server instructions and every tool's title and description", async () => {
    const { serverInstructions } = await import("./instructions");
    const texts = [serverInstructions("read"), serverInstructions("write"), ...writeTools.flatMap((t) => [t.name, (t as ListedTool & { title?: string }).title ?? "", t.description])];
    expect(texts.filter((text) => CODE_NAMES.test(prose(text)))).toEqual([]);
  });

  it("gives a write token the eight write tools, none read-only, with instructions that say no tool sends", async () => {
    const { serverInstructions } = await import("./instructions");
    const legacy = await callMcp(POST, { era: "legacy", token: writer.token, method: "initialize", params: legacyInitialize });
    expect((legacy.body as { result: { instructions: string } }).result.instructions).toBe(serverInstructions("write"));
    expect(serverInstructions("write")).toMatchSnapshot();

    const reads = new Set(tools.map((t) => t.name));
    const writes = writeTools.filter((t) => !reads.has(t.name));
    expect(writes.map((t) => t.name)).toEqual(["draft_campaign", "import_leads", "manage_task", "pause_sending", "set_reply_type", "update_conversation", "update_deal", "write_reply_draft"]);
    for (const tool of writes) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: false });
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }
    const tokens = Math.ceil(JSON.stringify(writeTools).length / CHARS_PER_TOKEN);
    expect(tokens).toBeLessThanOrEqual(WRITE_DEFINITION_TOKEN_BUDGET);
    expect(writes).toMatchSnapshot();
  });

  it("gives a send token the three send tools within budget, the launch preview read-only", async () => {
    const { serverInstructions } = await import("./instructions");
    const writes = new Set(writeTools.map((t) => t.name));
    const sends = sendTools.filter((t) => !writes.has(t.name));
    expect(sends.map((t) => t.name)).toEqual(["launch_campaign", "preview_campaign_launch", "send_reply"]);
    expect(sends.find((t) => t.name === "preview_campaign_launch")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(sends.find((t) => t.name === "send_reply")?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true, openWorldHint: true });
    const texts = [serverInstructions("send"), ...sends.flatMap((t) => [t.name, (t as ListedTool & { title?: string }).title ?? "", t.description])];
    expect(texts.filter((text) => CODE_NAMES.test(prose(text)))).toEqual([]);
    expect(Math.ceil(JSON.stringify(sendTools).length / CHARS_PER_TOKEN)).toBeLessThanOrEqual(SEND_DEFINITION_TOKEN_BUDGET);
    expect(sends).toMatchSnapshot();
  });
});
