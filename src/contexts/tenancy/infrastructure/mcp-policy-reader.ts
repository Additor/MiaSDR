import { and, eq, sql } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { mcpTokens, members } from "@/platform/db/schema";
import { env } from "@/shared/env";
import { agentIrreversiblePolicy, agentSendPolicy, agentSpendPolicy, usableScopes, type AgentActionRefusal, type AgentSendPolicy, type AgentSpendPolicy } from "../domain/mcp-policy";
import type { McpSettings } from "../domain/mcp-settings";
import { mcpSettingsIn } from "./mcp-settings-reader";
import { lockAgentSend } from "./agent-send-lock";

/** Published for a reply that must hold this lock before a row a member change also locks. */
export { lockAgentSend };

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
  const settings = await mcpSettingsIn(tx, input.organizationId);
  const [token] = await tx
    .select({ scopes: mcpTokens.scopes, policyEpoch: mcpTokens.policyEpoch, revokedAt: mcpTokens.revokedAt, expiresAt: mcpTokens.expiresAt, role: members.role })
    .from(mcpTokens)
    .leftJoin(members, and(eq(members.organizationId, mcpTokens.organizationId), eq(members.userId, mcpTokens.userId)))
    .where(and(eq(mcpTokens.id, input.tokenId), eq(mcpTokens.organizationId, input.organizationId)));
  // The route checked `enabled` before the lock; a person may have turned MCP off while this request waited.
  if (!settings.enabled) return { policy: { replies: false, campaigns: false, refusal: "mcp_off" }, settings };
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

export interface AgentActionGate {
  spend: AgentSpendPolicy;
  irreversible: AgentActionRefusal | null;
  settings: McpSettings;
}

/**
 * Whether an agent's token may spend or take actions a person cannot undo now, read inside the caller's transaction
 * under the agent-send lock, shared: reservations against one limit stay safe with a conditional write, and a policy
 * save or a revoke waits for them.
 */
export async function readAgentActionGate(tx: DbHandle, input: { organizationId: string; tokenId: string; now: Date }): Promise<AgentActionGate> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`agent-send:${input.organizationId}`}, 0))`);
  const settings = await mcpSettingsIn(tx, input.organizationId);
  if (!settings.enabled) return { spend: { enrichment: false, search: false, refusal: "mcp_off" }, irreversible: "mcp_off", settings };
  const [row] = await tx
    .select({ scopes: mcpTokens.scopes, spendEpoch: mcpTokens.spendEpoch, irreversibleEpoch: mcpTokens.irreversibleEpoch, revokedAt: mcpTokens.revokedAt, expiresAt: mcpTokens.expiresAt, role: members.role })
    .from(mcpTokens)
    .leftJoin(members, and(eq(members.organizationId, mcpTokens.organizationId), eq(members.userId, mcpTokens.userId)))
    .where(and(eq(mcpTokens.id, input.tokenId), eq(mcpTokens.organizationId, input.organizationId)));
  const token = row
    ? { scopes: row.role === null ? [] : usableScopes({ role: row.role, settings, scopes: row.scopes }), spendEpoch: row.spendEpoch, irreversibleEpoch: row.irreversibleEpoch, revokedAt: row.revokedAt, expiresAt: row.expiresAt }
    : { scopes: [], spendEpoch: settings.agentSpendEpoch, irreversibleEpoch: settings.agentIrreversibleEpoch, revokedAt: input.now, expiresAt: null };
  return {
    spend: agentSpendPolicy({ installEnabled: env().MCP_SPEND_ENABLED, settings, token, now: input.now }),
    irreversible: agentIrreversiblePolicy({ installEnabled: env().MCP_IRREVERSIBLE_ENABLED, settings, token, now: input.now }),
    settings,
  };
}
