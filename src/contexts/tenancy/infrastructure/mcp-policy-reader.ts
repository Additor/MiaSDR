import { and, eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { channelSettings, mcpTokens, members } from "@/platform/db/schema";
import { env } from "@/shared/env";
import { agentSendPolicy, usableScopes, type AgentSendPolicy } from "../domain/mcp-policy";
import { MCP_SETTINGS_CHANNEL, readMcpSettings, type McpSettings } from "../domain/mcp-settings";
import { lockAgentSend } from "./agent-send-lock";

export interface AgentSendGate {
  policy: AgentSendPolicy;
  settings: McpSettings;
}

/**
 * Whether an agent's token may send now, read inside the caller's transaction after it takes the organization's
 * agent-send lock (docs/database.md, "Lock modes"). A reply takes the lock exclusive, so two agent replies count their
 * limits one after the other; a campaign start or an enroll takes it shared. A policy save, a token revoke and a member
 * change take it exclusive first, so an agent action that starts after one of them answers sees the new state.
 *
 * The token's scopes go through `usableScopes` with the person's role now: a member whose organization turned member
 * write tokens off, or who left, cannot send.
 */
export async function readAgentSendGate(tx: DbHandle, input: { organizationId: string; tokenId: string; lock: "exclusive" | "shared"; now: Date }): Promise<AgentSendGate> {
  if (input.lock === "exclusive") await lockAgentSend(tx, input.organizationId);
  else await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`agent-send:${input.organizationId}`}, 0))`);
  // Read in statements after the lock, so they see what a save that held it committed (READ COMMITTED).
  const [stored] = await tx
    .select({ values: channelSettings.values })
    .from(channelSettings)
    .where(and(eq(channelSettings.organizationId, input.organizationId), eq(channelSettings.channel, MCP_SETTINGS_CHANNEL)));
  const settings = readMcpSettings(stored?.values);
  const [token] = await tx
    .select({ scopes: mcpTokens.scopes, policyEpoch: mcpTokens.policyEpoch, revokedAt: mcpTokens.revokedAt, expiresAt: mcpTokens.expiresAt, role: members.role })
    .from(mcpTokens)
    .leftJoin(members, and(eq(members.organizationId, mcpTokens.organizationId), eq(members.userId, mcpTokens.userId)))
    .where(and(eq(mcpTokens.id, input.tokenId), eq(mcpTokens.organizationId, input.organizationId)));
  const policy = agentSendPolicy({
    installSendEnabled: env().MCP_SEND_ENABLED,
    settings,
    token: token
      ? { scopes: token.role === null ? [] : usableScopes({ role: token.role, settings, scopes: token.scopes }), policyEpoch: token.policyEpoch, revokedAt: token.revokedAt, expiresAt: token.expiresAt }
      : { scopes: [], policyEpoch: settings.agentSendEpoch, revokedAt: input.now, expiresAt: null },
    now: input.now,
  });
  return { policy, settings };
}
