import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { mcpTokens } from "@/platform/db/schema";

/**
 * The organization's agent-send lock (docs/database.md, "Lock modes"). A member change (a role change or a removal,
 * `drizzle-member-store.ts`) and a token revoke (`drizzle-mcp-token-admin-store.ts`) take it exclusive before any row
 * lock, so an agent action that starts after they answer sees the new state. A policy change must take it the same way.
 */
export const lockAgentSend = (tx: DbHandle, organizationId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agent-send:${organizationId}`}, 0))`);

/**
 * Revokes the organization's live MCP tokens that match and answers how many. The caller holds `lockAgentSend`.
 * Tokens are revoked, never deleted: a later invitation makes a new member row, and the old tokens stay dead.
 */
export async function revokeMcpTokensTx(tx: DbHandle, organizationId: string, match: { tokenId: string } | { userId: string } | "all"): Promise<number> {
  const scope = match === "all" ? undefined : "tokenId" in match ? eq(mcpTokens.id, match.tokenId) : eq(mcpTokens.userId, match.userId);
  const rows = await tx
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.organizationId, organizationId), isNull(mcpTokens.revokedAt), scope))
    .returning({ id: mcpTokens.id });
  return rows.length;
}
