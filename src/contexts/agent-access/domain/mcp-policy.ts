import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import type { McpSettings } from "./mcp-settings";

/**
 * What an MCP token may do. `mcp:send` needs `mcp:write`, which needs `mcp:read`. `mcp:spend` and `mcp:irreversible`
 * each need `mcp:write`, are independent of each other and of sending, and belong to owners and admins. The policies
 * below decide at call time from the install switch, the organization's settings and the token row, so a limit change
 * or a revoke applies to the next call without a new token.
 */
export const MCP_SCOPES = ["mcp:read", "mcp:write", "mcp:send", "mcp:spend", "mcp:irreversible"] as const;
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
  const spends = scopes.includes("mcp:spend");
  const irreversible = scopes.includes("mcp:irreversible");
  if ((spends || irreversible) && !scopes.includes("mcp:write")) return "A token that spends or takes actions a person cannot undo must also write.";
  if ((spends || irreversible) && !admin) return "Only owners and admins can create tokens that spend or take actions a person cannot undo.";
  if (spends && input.settings.agentSpendCentsPerDay === 0 && input.settings.agentSearchLeadsPerDay === 0) return "Agent spending is off in this organization. An owner or admin can set a daily limit.";
  if (irreversible && input.settings.agentIrreversiblePerDay === 0) return "Actions agents cannot undo are off in this organization. An owner or admin can set a daily limit.";
  return null;
}

/**
 * The stored scopes a token may use now. A token keeps the scopes it was made with, so a member whose organization
 * later turned off member write tokens, or an admin demoted to member there, loses write and send on the next call. A
 * member never keeps `mcp:spend` or `mcp:irreversible`, whatever the member write setting says. The policies still
 * decide each action.
 */
export function usableScopes(input: { role: string; settings: McpSettings; scopes: readonly string[] }): McpScope[] {
  const scopes = readScopes(input.scopes);
  if (isOwnerOrAdmin(input.role)) return scopes;
  if (input.settings.memberWriteTokens) return scopes.filter((scope) => scope !== "mcp:spend" && scope !== "mcp:irreversible");
  return scopes.filter((scope) => scope === "mcp:read");
}

/** The token fields the send policy reads. */
export interface PolicyToken {
  scopes: readonly string[];
  /** The organization's `agentSendEpoch` when the token was made. */
  policyEpoch: number;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export type AgentSendRefusal = "mcp_off" | "install_off" | "token_revoked" | "token_expired" | "no_send_scope" | "mode_off" | "epoch_changed";

export interface AgentSendPolicy {
  replies: boolean;
  campaigns: boolean;
  /** Why replies are refused, or null when they are allowed. Campaigns are also refused when the mode is `replies`. */
  refusal: AgentSendRefusal | null;
}

/**
 * Whether an agent holding this token may send replies and start campaigns now. `installSendEnabled` is the install's
 * switch for agent sending (`MCP_SEND_ENABLED`), which the caller reads. Checks run in a fixed order, so the refusal
 * names the first thing to fix.
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

/** The token fields the spend and irreversible policies read. */
export interface ActionPolicyToken {
  scopes: readonly string[];
  /** The organization's `agentSpendEpoch` when the token was made. */
  spendEpoch: number;
  /** The organization's `agentIrreversibleEpoch` when the token was made. */
  irreversibleEpoch: number;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export type AgentActionRefusal = "mcp_off" | "install_off" | "token_revoked" | "token_expired" | "no_scope" | "limit_off" | "epoch_changed";

export interface AgentSpendPolicy {
  enrichment: boolean;
  search: boolean;
  refusal: AgentActionRefusal | null;
}

/** The refusal shared by the two policies below, in the order that names the first thing to fix. */
function actionRefusal(input: { installEnabled: boolean; token: ActionPolicyToken; now: Date; scope: McpScope; limitsOff: boolean; epochMoved: boolean }): AgentActionRefusal | null {
  const { token } = input;
  if (!input.installEnabled) return "install_off";
  if (token.revokedAt) return "token_revoked";
  if (token.expiresAt && token.expiresAt.getTime() <= input.now.getTime()) return "token_expired";
  if (!hasScope(token.scopes, input.scope)) return "no_scope";
  if (input.limitsOff) return "limit_off";
  return input.epochMoved ? "epoch_changed" : null;
}

/**
 * Whether an agent holding this token may spend now. Enrichment and LinkedIn search have a limit each and share one
 * epoch, which moves only when both limits are 0, so setting one to 0 leaves the other running.
 */
export function agentSpendPolicy(input: { installEnabled: boolean; settings: McpSettings; token: ActionPolicyToken; now: Date }): AgentSpendPolicy {
  const { settings, token } = input;
  const refusal = actionRefusal({
    installEnabled: input.installEnabled,
    token,
    now: input.now,
    scope: "mcp:spend",
    limitsOff: settings.agentSpendCentsPerDay === 0 && settings.agentSearchLeadsPerDay === 0,
    epochMoved: token.spendEpoch !== settings.agentSpendEpoch,
  });
  if (refusal) return { enrichment: false, search: false, refusal };
  return { enrichment: settings.agentSpendCentsPerDay > 0, search: settings.agentSearchLeadsPerDay > 0, refusal: null };
}

/** Whether an agent holding this token may take actions a person cannot undo now. Answers the refusal, or null. */
export function agentIrreversiblePolicy(input: { installEnabled: boolean; settings: McpSettings; token: ActionPolicyToken; now: Date }): AgentActionRefusal | null {
  return actionRefusal({
    installEnabled: input.installEnabled,
    token: input.token,
    now: input.now,
    scope: "mcp:irreversible",
    limitsOff: input.settings.agentIrreversiblePerDay === 0,
    epochMoved: input.token.irreversibleEpoch !== input.settings.agentIrreversibleEpoch,
  });
}

/**
 * What a token does now, as the token list shows it: send only while the send policy allows it, write while the
 * person's role and the member write setting allow it. `sendRetired` marks a send token that cannot send again, after
 * agent sending went off or the policy moved on: a new token sends.
 */
export function tokenAccess(input: { role: string | null; installSendEnabled: boolean; settings: McpSettings; token: PolicyToken; now: Date }): { access: "read" | "write" | "send"; sendRetired: boolean } {
  const scopes = input.role === null ? [] : usableScopes({ role: input.role, settings: input.settings, scopes: input.token.scopes });
  const policy = agentSendPolicy({ installSendEnabled: input.installSendEnabled, settings: input.settings, token: { ...input.token, scopes }, now: input.now });
  const sendRetired = hasScope(input.token.scopes, "mcp:send") && (policy.refusal === "mode_off" || policy.refusal === "epoch_changed");
  return { access: policy.replies ? "send" : scopes.includes("mcp:write") ? "write" : "read", sendRetired };
}

/**
 * What a token may spend and do without undo now, as the token list shows it. `spendRetired` and `irreversibleRetired`
 * mark a token that will not do it again because the limit dropped to 0 or the epoch moved on: a new token does.
 */
export function tokenActions(input: { role: string | null; installSpendEnabled: boolean; installIrreversibleEnabled: boolean; settings: McpSettings; token: ActionPolicyToken; now: Date }): { spends: boolean; spendRetired: boolean; irreversible: boolean; irreversibleRetired: boolean } {
  const scopes = input.role === null ? [] : usableScopes({ role: input.role, settings: input.settings, scopes: input.token.scopes });
  const token = { ...input.token, scopes };
  const spend = agentSpendPolicy({ installEnabled: input.installSpendEnabled, settings: input.settings, token, now: input.now });
  const irreversible = agentIrreversiblePolicy({ installEnabled: input.installIrreversibleEnabled, settings: input.settings, token, now: input.now });
  const retired = (refusal: AgentActionRefusal | null) => refusal === "limit_off" || refusal === "epoch_changed";
  return {
    spends: spend.enrichment || spend.search,
    spendRetired: hasScope(input.token.scopes, "mcp:spend") && retired(spend.refusal),
    irreversible: irreversible === null,
    irreversibleRetired: hasScope(input.token.scopes, "mcp:irreversible") && retired(irreversible),
  };
}
