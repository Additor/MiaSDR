import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { mcpTokens, mcpToolCalls, users } from "@/platform/db/schema";
import type { McpToolCallStore } from "../application/mcp-tool-calls";

export const drizzleMcpToolCallStore: McpToolCallStore = {
  async insert(entry) {
    await db.insert(mcpToolCalls).values(entry);
  },

  async list(organizationId, { writesOnly, before, limit }) {
    // Keyset paging on (created_at, id): the call named by `before` and every newer one stay out.
    const cursor = before
      ? sql`(${mcpToolCalls.createdAt}, ${mcpToolCalls.id}) < (select c.created_at, c.id from mcp_tool_calls c where c.id = ${before} and c.organization_id = ${organizationId})`
      : undefined;
    const rows = await db
      .select({
        id: mcpToolCalls.id,
        tool: mcpToolCalls.tool,
        action: mcpToolCalls.action,
        kind: mcpToolCalls.kind,
        target: mcpToolCalls.target,
        errorCode: mcpToolCalls.errorCode,
        clientName: mcpToolCalls.clientName,
        durationMs: mcpToolCalls.durationMs,
        createdAt: mcpToolCalls.createdAt,
        tokenId: mcpToolCalls.tokenId,
        tokenName: mcpTokens.name,
        userId: mcpTokens.userId,
        userName: users.name,
      })
      .from(mcpToolCalls)
      .innerJoin(mcpTokens, and(eq(mcpTokens.id, mcpToolCalls.tokenId), eq(mcpTokens.organizationId, mcpToolCalls.organizationId)))
      .innerJoin(users, eq(users.id, mcpTokens.userId))
      .where(and(eq(mcpToolCalls.organizationId, organizationId), writesOnly ? eq(mcpToolCalls.kind, "write") : undefined, cursor))
      .orderBy(desc(mcpToolCalls.createdAt), desc(mcpToolCalls.id))
      .limit(limit);
    return rows;
  },
};
