import { ForbiddenError, type Actor } from "@/shared/errors";
import { isOwnerOrAdmin } from "../domain/roles";

/** One tool call as the MCP endpoint records it. `target` holds ids only. */
export interface McpToolCallEntry {
  organizationId: string;
  tokenId: string;
  tool: string;
  action: string | null;
  kind: "read" | "write";
  target: Record<string, string>;
  /** Null when the call succeeded. */
  errorCode: string | null;
  clientName: string | null;
  durationMs: number;
}

/** A logged call as the activity list shows it, with the token and its person. */
export interface McpToolCallView {
  id: string;
  tool: string;
  action: string | null;
  kind: "read" | "write";
  target: Record<string, string>;
  errorCode: string | null;
  clientName: string | null;
  durationMs: number;
  createdAt: Date;
  tokenId: string;
  tokenName: string;
  userId: string;
  userName: string;
}

export const MCP_TOOL_CALL_PAGE_SIZE = 50;

export interface McpToolCallStore {
  insert(entry: McpToolCallEntry): Promise<void>;
  /** Newest first, one page past `before` (a call id), with `pageSize + 1` rows so the caller knows if more follow. */
  list(organizationId: string, filter: { writesOnly: boolean; before: string | null; limit: number }): Promise<McpToolCallView[]>;
}

export interface McpToolCallDeps {
  store: McpToolCallStore;
}

/** The ids a tool call names, from its input. Text such as a note or a reply body stays out of the log. */
export const TARGET_KEYS = ["conversationId", "threadId", "draftId", "personId", "campaignId", "taskId", "dealId", "stageId", "replyTypePickId", "userId", "tableId", "columnKey", "searchId"] as const;

export function callTarget(input: unknown): Record<string, string> {
  const values = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const target: Record<string, string> = {};
  for (const key of TARGET_KEYS) {
    const value = values[key];
    if (typeof value === "string" && value.length <= 100) target[key] = value;
  }
  return target;
}

/** Text Postgres can store: a client writes these values, and a NUL or half a surrogate pair would lose the whole row. */
const storable = (text: string): string => text.replaceAll("\0", "").toWellFormed();

export async function recordMcpToolCall(deps: McpToolCallDeps, entry: McpToolCallEntry): Promise<void> {
  await deps.store.insert({
    ...entry,
    tool: storable(entry.tool),
    action: entry.action && storable(entry.action),
    clientName: entry.clientName && storable(entry.clientName),
    target: Object.fromEntries(Object.entries(entry.target).map(([key, value]) => [key, storable(value)])),
  });
}

/** The organization's agent activity, newest first. Owners and admins only. */
export async function listMcpToolCalls(
  deps: McpToolCallDeps,
  actor: Actor,
  filter: { writesOnly: boolean; before: string | null },
): Promise<{ calls: McpToolCallView[]; more: boolean }> {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can see agent activity.");
  const rows = await deps.store.list(actor.organizationId, { ...filter, limit: MCP_TOOL_CALL_PAGE_SIZE + 1 });
  return { calls: rows.slice(0, MCP_TOOL_CALL_PAGE_SIZE), more: rows.length > MCP_TOOL_CALL_PAGE_SIZE };
}
