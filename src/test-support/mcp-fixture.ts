import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { callMcp, type McpCallResult, type McpEra } from "./mcp-client";

type Handler = (request: Request) => Promise<Response>;

/** An organization's member with a live read token, for calling tools through the route. */
export interface McpCaller {
  token: string;
  tokenId: string;
  /** `tools/call` through the route. Answers the tool result, or throws with the JSON-RPC error. */
  tool(name: string, args?: Record<string, unknown>, era?: McpEra): Promise<ToolCallResult>;
}

export interface ToolCallResult {
  isError: boolean;
  text: string;
  structured: Record<string, unknown>;
}

/** Turns MCP on for the organization. */
export const enableMcp = (sql: postgres.Sql, organizationId: string) =>
  sql`insert into channel_settings (organization_id, channel, values) values (${organizationId}, 'mcp', ${sql.json({ enabled: true })})
      on conflict (organization_id, channel) do update set values = channel_settings.values || excluded.values`;

/** A personal token for the member, stored the way the token API stores it. */
export async function mcpCaller(sql: postgres.Sql, POST: Handler, member: { organizationId: string; userId: string }, scopes = ["mcp:read"]): Promise<McpCaller> {
  const token = `msdr_pat_${randomBytes(32).toString("base64url")}`;
  const [{ id }] = await sql<{ id: string }[]>`
    insert into mcp_tokens (organization_id, user_id, kind, name, token_hash, token_hint, scopes)
    values (${member.organizationId}, ${member.userId}, 'pat', 'Test agent', ${createHash("sha256").update(token).digest("hex")}, ${token.slice(-4)}, ${scopes})
    returning id`;
  return {
    token,
    tokenId: id,
    async tool(name, args = {}, era = "modern") {
      const result: McpCallResult = await callMcp(POST, { era, token, method: "tools/call", params: { name, arguments: args } });
      const body = result.body as { result?: { isError?: boolean; content?: Array<{ text: string }>; structuredContent?: Record<string, unknown> }; error?: unknown };
      if (result.status !== 200 || !body.result) throw new Error(`tools/call ${name} answered ${result.status}: ${JSON.stringify(result.body)}`);
      return { isError: body.result.isError ?? false, text: (body.result.content ?? []).map((c) => c.text).join("\n"), structured: body.result.structuredContent ?? {} };
    },
  };
}
