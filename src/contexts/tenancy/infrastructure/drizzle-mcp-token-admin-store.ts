import { and, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { channelSettings, mcpTokens, members, users } from "@/platform/db/schema";
import type { McpTokenRow, McpTokenStore, McpTokenView } from "../application/mcp-tokens";
import { readScopes } from "../domain/mcp-policy";
import { MCP_SETTINGS_CHANNEL } from "../domain/mcp-settings";
import { lockAgentSend, revokeMcpTokensTx } from "./agent-send-lock";
import { recordAudit } from "./audit";
import { mergeChannelSettings } from "./channel-settings";
import { drizzleMcpTokenStore } from "./drizzle-mcp-token-store";
import { mcpSettingsIn } from "./mcp-settings-reader";

const viewColumns = {
  id: mcpTokens.id,
  name: mcpTokens.name,
  hint: mcpTokens.tokenHint,
  scopes: mcpTokens.scopes,
  ownerUserId: mcpTokens.userId,
  ownerName: users.name,
  createdAt: mcpTokens.createdAt,
  expiresAt: mcpTokens.expiresAt,
  lastUsedAt: mcpTokens.lastUsedAt,
};

const toView = (row: Omit<McpTokenView, "scopes"> & { scopes: string[] }): McpTokenView => ({ ...row, scopes: readScopes(row.scopes) });

/** The token list, creation and revoke behind Settings > MCP. `drizzle-mcp-token-store.ts` serves the MCP requests. */
export const drizzleMcpTokenAdminStore: McpTokenStore = {
  async list(organizationId, userId) {
    const rows = await db
      .select({ ...viewColumns, ownerRole: members.role, policyEpoch: mcpTokens.policyEpoch })
      .from(mcpTokens)
      .innerJoin(users, eq(users.id, mcpTokens.userId))
      .leftJoin(members, and(eq(members.organizationId, mcpTokens.organizationId), eq(members.userId, mcpTokens.userId)))
      .where(and(eq(mcpTokens.organizationId, organizationId), isNull(mcpTokens.revokedAt), userId ? eq(mcpTokens.userId, userId) : undefined))
      .orderBy(desc(mcpTokens.createdAt), desc(mcpTokens.id));
    return rows.map((row): McpTokenRow => ({ ...toView(row), ownerRole: row.ownerRole, policyEpoch: row.policyEpoch }));
  },

  async owner(organizationId, tokenId) {
    const [row] = await db
      .select({ userId: mcpTokens.userId })
      .from(mcpTokens)
      .where(and(eq(mcpTokens.organizationId, organizationId), eq(mcpTokens.id, tokenId)));
    return row ?? null;
  },

  forMember(organizationId, userId, run) {
    return db.transaction(async (tx) => {
      // `removeMember` deletes this row after it takes the agent-send lock; holding it here keeps a new token out of
      // the gap between that removal's revoke and its commit.
      const [member] = await tx
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)))
        .for("update");
      if (!member) return null;
      return run({
        async liveCount(now) {
          const [row] = await tx
            .select({ n: count() })
            .from(mcpTokens)
            .where(
              and(
                eq(mcpTokens.organizationId, organizationId),
                eq(mcpTokens.userId, userId),
                isNull(mcpTokens.revokedAt),
                or(isNull(mcpTokens.expiresAt), gt(mcpTokens.expiresAt, now)),
              ),
            );
          return row.n;
        },
        async insert(token, audit) {
          const [created] = await tx
            .insert(mcpTokens)
            .values({ ...token, kind: "pat" })
            .returning({ id: mcpTokens.id });
          await recordAudit(tx, { ...audit, entityType: "mcp_token", entityId: created.id });
          const [row] = await tx.select(viewColumns).from(mcpTokens).innerJoin(users, eq(users.id, mcpTokens.userId)).where(eq(mcpTokens.id, created.id));
          return toView(row);
        },
      });
    });
  },

  revoke(organizationId, match, audit) {
    return db.transaction(async (tx) => {
      await lockAgentSend(tx, organizationId);
      const revoked = await revokeMcpTokensTx(tx, organizationId, match);
      if (revoked > 0) await recordAudit(tx, { ...audit, meta: { ...audit.meta, count: revoked } });
      return revoked;
    });
  },

  settings: drizzleMcpTokenStore.settings,

  async saveSettings(organizationId, patch, userId, audit) {
    await db.transaction(async (tx) => {
      // A policy change: agent actions that start after it answers see the new settings.
      await lockAgentSend(tx, organizationId);
      const current = await mcpSettingsIn(tx, organizationId);
      await mergeChannelSettings(tx, organizationId, MCP_SETTINGS_CHANNEL, patch, userId);
      // Turning agent sending off retires every send token made before: the epoch moves past the stored one and past
      // every token's, so turning it back on later does not revive them.
      if (patch.agentSendMode === "off" && current.agentSendMode !== "off") {
        const where = and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, MCP_SETTINGS_CHANNEL));
        await tx
          .update(channelSettings)
          .set({
            values: sql`jsonb_set(${channelSettings.values}, '{agentSendEpoch}', to_jsonb(greatest(
              ${current.agentSendEpoch}::bigint,
              (select coalesce(max(${mcpTokens.policyEpoch}), 0) from ${mcpTokens} where ${mcpTokens.organizationId} = ${organizationId})
            ) + 1))`,
          })
          .where(where);
      }
      for (const entry of audit) await recordAudit(tx, entry);
    });
  },
};
