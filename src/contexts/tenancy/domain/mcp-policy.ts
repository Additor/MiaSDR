import { isOwnerOrAdmin } from "./roles";
import type { McpSettings } from "./mcp-settings";

/**
 * What an MCP token may do. Each scope needs the one before it: `mcp:send` needs `mcp:write`, which needs `mcp:read`.
 * The send policy decides at call time from the install switch, the organization's settings and the token row, so a
 * mode change or a revoke applies to the next call without a new token.
 */
export const MCP_SCOPES = ["mcp:read", "mcp:write", "mcp:send"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

const isScope = (value: string): value is McpScope => (MCP_SCOPES as readonly string[]).includes(value);

/** The scopes stored on a token, unknown words dropped. */
export function readScopes(stored: readonly string[]): McpScope[] {
  return MCP_SCOPES.filter((scope) => stored.includes(scope));
}

export const hasScope = (scopes: readonly string[], scope: McpScope): boolean => readScopes(scopes).includes(scope);

/** Why a person may not create a token with these scopes, as a sentence, or null when they may. */
export function tokenScopesProblem(input: { role: string; settings: McpSettings; scopes: readonly string[] }): string | null {
  const unknown = input.scopes.filter((scope) => !isScope(scope));
  if (unknown.length > 0) return `Unknown scope: ${unknown.join(", ")}.`;
  const scopes = readScopes(input.scopes);
  if (!scopes.includes("mcp:read")) return "A token needs the read scope.";
  if (scopes.includes("mcp:send") && !scopes.includes("mcp:write")) return "A token that sends must also write.";
  const admin = isOwnerOrAdmin(input.role);
  if (scopes.includes("mcp:write") && !admin && !input.settings.memberWriteTokens) return "Only owners and admins can create tokens that write in this organization.";
  if (scopes.includes("mcp:send") && input.settings.agentSendMode === "off") return "Agent sending is off in this organization. An owner or admin can turn it on.";
  return null;
}

/** The token fields the send policy reads. */
export interface PolicyToken {
  scopes: readonly string[];
  /** The organization's `agentSendEpoch` when the token was made. */
  policyEpoch: number;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export type AgentSendRefusal = "install_off" | "token_revoked" | "token_expired" | "no_send_scope" | "mode_off" | "epoch_changed";

export interface AgentSendPolicy {
  replies: boolean;
  campaigns: boolean;
  /** Why replies are refused, or null when they are allowed. Campaigns are also refused when the mode is `replies`. */
  refusal: AgentSendRefusal | null;
}

/**
 * Whether an agent holding this token may send replies and start campaigns now. `installSendEnabled` is the
 * `MCP_SEND_ENABLED` switch. Checks run in a fixed order, so the refusal names the first thing to fix.
 */
export function agentSendPolicy(input: { installSendEnabled: boolean; settings: McpSettings; token: PolicyToken; now: Date }): AgentSendPolicy {
  const refuse = (refusal: AgentSendRefusal): AgentSendPolicy => ({ replies: false, campaigns: false, refusal });
  const { settings, token } = input;
  if (!input.installSendEnabled) return refuse("install_off");
  if (token.revokedAt) return refuse("token_revoked");
  if (token.expiresAt && token.expiresAt.getTime() <= input.now.getTime()) return refuse("token_expired");
  if (!hasScope(token.scopes, "mcp:send")) return refuse("no_send_scope");
  if (settings.agentSendMode === "off") return refuse("mode_off");
  if (token.policyEpoch !== settings.agentSendEpoch) return refuse("epoch_changed");
  return { replies: true, campaigns: settings.agentSendMode === "replies_and_campaigns", refusal: null };
}
