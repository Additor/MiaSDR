import { and, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db, type DbHandle } from "@/platform/db/client";
import { channelSettings, mcpTokens, members, users } from "@/platform/db/schema";
import type { McpTokenRow, McpTokenStore, McpTokenView } from "../application/mcp-tokens";
import { readScopes } from "../domain/mcp-policy";
import { MCP_SETTINGS_CHANNEL, type McpSettings } from "../domain/mcp-settings";
import { lockAgentSend, revokeMcpTokensTx } from "./agent-send-lock";
import { recordAudit } from "./audit";
import { mergeChannelSettings } from "./channel-settings";
import { drizzleMcpTokenStore } from "./drizzle-mcp-token-store";
import { mcpSettingsIn } from "./mcp-settings-reader";

const viewColumns = {
  id: mcpTokens.id,
  name: mcpTokens.name,
  hint: mcpTokens.tokenHint,
  kind: mcpTokens.kind,
  scopes: mcpTokens.scopes,
  ownerUserId: mcpTokens.userId,
  ownerName: users.name,
  createdAt: mcpTokens.createdAt,
  expiresAt: mcpTokens.expiresAt,
  lastUsedAt: mcpTokens.lastUsedAt,
};

const toView = (row: Omit<McpTokenView, "scopes"> & { scopes: string[] }): McpTokenView => ({ ...row, scopes: readScopes(row.scopes) });

/** Moves a stored epoch past its current value and past every token's. The caller holds `lockAgentSend`. */
async function moveEpoch(tx: DbHandle, organizationId: string, key: "agentSendEpoch" | "agentSpendEpoch" | "agentIrreversibleEpoch", current: number, column: AnyPgColumn) {
  await tx
    .update(channelSettings)
    .set({
      values: sql`jsonb_set(${channelSettings.values}, ${`{${key}}`}::text[], to_jsonb(greatest(
        ${current}::bigint,
        (select coalesce(max(${column}), 0) from ${mcpTokens} where ${mcpTokens.organizationId} = ${organizationId})
      ) + 1))`,
    })
    .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, MCP_SETTINGS_CHANNEL)));
}

/** The token list, creation and revoke behind Settings > MCP. `drizzle-mcp-token-store.ts` serves the MCP requests. */
export const drizzleMcpTokenAdminStore: McpTokenStore = {
  async list(organizationId, userId) {
    const rows = await db
      .select({ ...viewColumns, ownerRole: members.role, policyEpoch: mcpTokens.policyEpoch, spendEpoch: mcpTokens.spendEpoch, irreversibleEpoch: mcpTokens.irreversibleEpoch })
      .from(mcpTokens)
      .innerJoin(users, eq(users.id, mcpTokens.userId))
      .leftJoin(members, and(eq(members.organizationId, mcpTokens.organizationId), eq(members.userId, mcpTokens.userId)))
      .where(and(eq(mcpTokens.organizationId, organizationId), isNull(mcpTokens.revokedAt), userId ? eq(mcpTokens.userId, userId) : undefined))
      .orderBy(desc(mcpTokens.createdAt), desc(mcpTokens.id));
    return rows.map((row): McpTokenRow => ({ ...toView(row), ownerRole: row.ownerRole, policyEpoch: row.policyEpoch, spendEpoch: row.spendEpoch, irreversibleEpoch: row.irreversibleEpoch }));
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
                // An app a person connected is not a secret they hold, so it does not use up the limit.
                eq(mcpTokens.kind, "pat"),
                isNull(mcpTokens.revokedAt),
                or(isNull(mcpTokens.expiresAt), gt(mcpTokens.expiresAt, now)),
              ),
            );
          return row.n;
        },
        async upsertGrant(grant, audit) {
          const [row] = await tx
            .insert(mcpTokens)
            .values({ ...grant, kind: "oauth" })
            .onConflictDoUpdate({ target: mcpTokens.oauthGrantId, set: { name: grant.name, scopes: grant.scopes, policyEpoch: grant.policyEpoch, spendEpoch: grant.spendEpoch, irreversibleEpoch: grant.irreversibleEpoch, revokedAt: null } })
            .returning({ id: mcpTokens.id });
          await recordAudit(tx, { ...audit, entityType: "mcp_token", entityId: row.id });
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
      // every token's, so turning it back on later does not revive them. Spending and irreversible actions work the same.
      if (patch.agentSendMode === "off" && current.agentSendMode !== "off") await moveEpoch(tx, organizationId, "agentSendEpoch", current.agentSendEpoch, mcpTokens.policyEpoch);
      const next = { ...current, ...patch };
      const spends = (settings: McpSettings) => settings.agentSpendCentsPerDay > 0 || settings.agentSearchLeadsPerDay > 0;
      if (spends(current) && !spends(next)) await moveEpoch(tx, organizationId, "agentSpendEpoch", current.agentSpendEpoch, mcpTokens.spendEpoch);
      if (current.agentIrreversiblePerDay > 0 && next.agentIrreversiblePerDay === 0) await moveEpoch(tx, organizationId, "agentIrreversibleEpoch", current.agentIrreversibleEpoch, mcpTokens.irreversibleEpoch);
      for (const entry of audit) await recordAudit(tx, entry);
    });
  },
};
