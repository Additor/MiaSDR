import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { mcpTokens, members } from "@/platform/db/schema";
import { TOUCH_INTERVAL_MS, type McpPrincipalStore } from "../application/mcp-principal";
import { mcpSettingsIn } from "./mcp-settings-reader";

export const drizzleMcpTokenStore: McpPrincipalStore = {
  async findPersonalToken(tokenHash) {
    const [row] = await db
      .select({
        id: mcpTokens.id,
        name: mcpTokens.name,
        organizationId: mcpTokens.organizationId,
        userId: mcpTokens.userId,
        scopes: mcpTokens.scopes,
        policyEpoch: mcpTokens.policyEpoch,
        expiresAt: mcpTokens.expiresAt,
        revokedAt: mcpTokens.revokedAt,
        lastUsedAt: mcpTokens.lastUsedAt,
        role: members.role,
      })
      .from(mcpTokens)
      .leftJoin(members, and(eq(members.organizationId, mcpTokens.organizationId), eq(members.userId, mcpTokens.userId)))
      .where(and(eq(mcpTokens.kind, "pat"), eq(mcpTokens.tokenHash, tokenHash)))
      .limit(1);
    return row ?? null;
  },

  async touch(tokenId, now) {
    await db
      .update(mcpTokens)
      .set({ lastUsedAt: now })
      .where(and(eq(mcpTokens.id, tokenId), or(isNull(mcpTokens.lastUsedAt), lt(mcpTokens.lastUsedAt, new Date(now.getTime() - TOUCH_INTERVAL_MS)))));
  },

  settings: (organizationId) => mcpSettingsIn(db, organizationId),
};
