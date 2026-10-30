/**
 * The MCP counterpart of `./api.ts`. The MCP route resolves a token to a principal; `mcpActor` turns it into the
 * `Actor` the use cases take, marked with `via`, and `runTool` runs one tool call and maps its errors the way `answer()`
 * does, as a tool error the agent can read. The SDK sends a thrown error's message to the agent as it is, so every tool
 * runs inside `runTool`: an error `classifyError` does not know is logged here and the agent gets a plain sentence.
 */
import { z } from "zod";
import type { McpPrincipal } from "@/contexts/tenancy/application/mcp-principal";
import { STATUS_CODES } from "./api-errors";
import { classifyError } from "./classify-error";
import type { Actor } from "@/shared/errors";

/** The client name in a 2026-07-28 request envelope. The client writes it, so it is checked before use. */
const clientInfo = z.object({ name: z.string().trim().min(1).max(100) });

export function clientNameFrom(envelope: unknown): string | null {
  const info = (envelope as Record<string, unknown> | null | undefined)?.["io.modelcontextprotocol/clientInfo"];
  const parsed = clientInfo.safeParse(info);
  return parsed.success ? parsed.data.name : null;
}

export const mcpActor = (principal: McpPrincipal, clientName: string | null): Actor => ({
  userId: principal.userId,
  organizationId: principal.organizationId,
  role: principal.role,
  via: { kind: "agent", tokenId: principal.tokenId, tokenName: principal.tokenName, clientName },
});

/** A tool result: a short summary for the model, the structured data as the source of truth. */
export interface ToolOutput<T extends Record<string, unknown>> {
  summary: string;
  structured: T;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const SERVER_ERROR_MESSAGE = "Something went wrong on the server. Try again later, and tell an admin if it keeps happening.";

/**
 * Runs one tool call. A classified error answers with its sentence and `structuredContent.error`
 * (`{ code, message, ...details }`, the same code a JSON route would give); anything else is logged with the tool name
 * and answers `server_error`. A `SyntaxError` counts as unknown: the SDK parses the request body before the tool runs,
 * so one thrown here comes from the tool's own code, and the JSON route's "Invalid JSON" would blame the agent.
 */
export async function runTool<T extends Record<string, unknown>>(tool: string, actor: Actor, run: (actor: Actor) => Promise<ToolOutput<T>>): Promise<ToolResult> {
  try {
    const { summary, structured } = await run(actor);
    return { content: [{ type: "text", text: summary }], structuredContent: structured };
  } catch (error) {
    const classified = error instanceof SyntaxError ? null : classifyError(error);
    if (!classified) {
      console.error(`[mcp] ${tool} failed for organization ${actor.organizationId}`, error);
      return toolError("server_error", SERVER_ERROR_MESSAGE, {});
    }
    const code = typeof classified.details.code === "string" ? classified.details.code : STATUS_CODES[classified.status];
    return toolError(code, classified.message, classified.details);
  }
}

function toolError(code: string, message: string, details: Record<string, unknown>): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }], structuredContent: { error: { ...details, code, message } } };
}
