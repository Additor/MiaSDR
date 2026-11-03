import { isMcpTokenFormat, mcpGrantId } from "../domain/mcp-token";
import { agentIrreversiblePolicy, agentSendPolicy, agentSpendPolicy, usableScopes, type McpScope } from "../domain/mcp-policy";
import type { McpSettings } from "../domain/mcp-settings";

/**
 * Who an MCP request acts as. The role and the organization's settings come from the database on every request, so a
 * removed member, a demoted admin or a settings change applies on the next call. The token's organization is the
 * only one it can reach: unlike the session, nothing falls back to another organization the person belongs to.
 */
export interface McpPrincipal {
  tokenId: string;
  tokenName: string;
  userId: string;
  organizationId: string;
  role: string;
  /** The stored scopes the person may still use (`usableScopes`). */
  scopes: McpScope[];
  /** The organization's `agentSendEpoch` when the token was made. */
  policyEpoch: number;
  expiresAt: Date | null;
  /**
   * What the policies allowed when the request arrived, which decides whether `tools/list` offers the tools that need
   * them. Each action reads its policy again under the agent-send lock.
   */
  allows: Record<PrincipalAllowance, boolean>;
}

export type PrincipalAllowance = "replies" | "campaigns" | "enrichment" | "search" | "irreversible";

export interface StoredMcpToken {
  id: string;
  name: string;
  organizationId: string;
  userId: string;
  scopes: string[];
  policyEpoch: number;
  spendEpoch: number;
  irreversibleEpoch: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  /** The person's role in the token's organization, or null when they are no longer a member. */
  role: string | null;
}

/** How stale `lastUsedAt` may get before a request writes it again. */
export const TOUCH_INTERVAL_MS = 60_000;

export interface McpPrincipalStore {
  findPersonalToken(tokenHash: string): Promise<StoredMcpToken | null>;
  findGrant(grantId: string): Promise<StoredMcpToken | null>;
  /** Records use. The store also skips the write when the last one is under `TOUCH_INTERVAL_MS` old, for two requests that race. */
  touch(tokenId: string, now: Date): Promise<void>;
  settings(organizationId: string): Promise<McpSettings>;
}

export interface McpPrincipalDeps {
  store: McpPrincipalStore;
  /** Hex SHA-256 of a token. */
  hash: (token: string) => string;
  now: () => Date;
  /** `MCP_SEND_ENABLED`: the install lets agents send at all. */
  installSendEnabled: () => boolean;
  /** `MCP_SPEND_ENABLED`: the install lets agents spend at all. */
  installSpendEnabled: () => boolean;
  /** `MCP_IRREVERSIBLE_ENABLED`: the install lets agents take actions a person cannot undo. */
  installIrreversibleEnabled: () => boolean;
}

/** A principal, or the organization's refusal. A token that resolves to nobody gives null. */
export type McpAccess = { principal: McpPrincipal } | { refusal: "mcp_disabled" };

/**
 * The principal behind a personal token, or null when the token is malformed, unknown, revoked or expired, or its
 * owner left the organization. Every null case answers the same 401, so a caller cannot tell which one it hit. A
 * live token of an organization with MCP off gets the refusal, and its use is not recorded.
 */
export async function resolveMcpAccess(deps: McpPrincipalDeps, token: string | null): Promise<McpAccess | null> {
  if (!token || !isMcpTokenFormat(token)) return null;
  // The lookup is by hash, so the secret itself is never compared and its timing reveals nothing.
  return accessOf(deps, await deps.store.findPersonalToken(deps.hash(token)));
}

/**
 * The principal behind a verified OAuth access token, on the same terms as a personal token. The `mcp_tokens` row
 * decides, so a revoked grant stops at once though its token has not expired, and the token's own scopes can only narrow
 * what the person agreed to.
 */
export async function resolveMcpGrant(deps: McpPrincipalDeps, claims: { userId: string; organizationId: string; clientId: string; scopes: readonly string[] }): Promise<McpAccess | null> {
  const row = await deps.store.findGrant(mcpGrantId(claims.organizationId, claims.userId, claims.clientId));
  return accessOf(deps, row && { ...row, scopes: row.scopes.filter((scope) => claims.scopes.includes(scope)) });
}

async function accessOf(deps: McpPrincipalDeps, row: StoredMcpToken | null): Promise<McpAccess | null> {
  const now = deps.now();
  if (!row || row.revokedAt || row.role === null) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  const settings = await deps.store.settings(row.organizationId);
  if (!settings.enabled) return { refusal: "mcp_disabled" };
  // Most requests find a recent `lastUsedAt` and skip the round trip.
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) await deps.store.touch(row.id, now);
  const scopes = usableScopes({ role: row.role, settings, scopes: row.scopes });
  const token = { scopes, policyEpoch: row.policyEpoch, spendEpoch: row.spendEpoch, irreversibleEpoch: row.irreversibleEpoch, revokedAt: row.revokedAt, expiresAt: row.expiresAt };
  const policy = agentSendPolicy({ installSendEnabled: deps.installSendEnabled(), settings, token, now });
  const spend = agentSpendPolicy({ installEnabled: deps.installSpendEnabled(), settings, token, now });
  return {
    principal: {
      tokenId: row.id,
      tokenName: row.name,
      userId: row.userId,
      organizationId: row.organizationId,
      role: row.role,
      scopes,
      policyEpoch: row.policyEpoch,
      expiresAt: row.expiresAt,
      allows: {
        replies: policy.replies,
        campaigns: policy.campaigns,
        enrichment: spend.enrichment,
        search: spend.search,
        irreversible: agentIrreversiblePolicy({ installEnabled: deps.installIrreversibleEnabled(), settings, token, now }) === null,
      },
    },
  };
}
