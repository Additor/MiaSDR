import { isMcpTokenFormat } from "../domain/mcp-token";
import { readScopes, type McpScope } from "../domain/mcp-policy";
import type { McpSettings } from "../domain/mcp-settings";

/**
 * Who an MCP request acts as. The role comes from `members` on every request, so a removed member or a demoted
 * admin loses access on the next call. The token's organization is the only one it can reach: unlike the session,
 * nothing falls back to another organization the person belongs to.
 */
export interface McpPrincipal {
  tokenId: string;
  tokenName: string;
  userId: string;
  organizationId: string;
  role: string;
  scopes: McpScope[];
  /** The organization's `agentSendEpoch` when the token was made. */
  policyEpoch: number;
  expiresAt: Date | null;
}

export interface StoredMcpToken {
  id: string;
  name: string;
  organizationId: string;
  userId: string;
  scopes: string[];
  policyEpoch: number;
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
  /** Records use. The store also skips the write when the last one is under `TOUCH_INTERVAL_MS` old, for two requests that race. */
  touch(tokenId: string, now: Date): Promise<void>;
  settings(organizationId: string): Promise<McpSettings>;
}

export interface McpPrincipalDeps {
  store: McpPrincipalStore;
  /** Hex SHA-256 of a token. */
  hash: (token: string) => string;
  now: () => Date;
}

/**
 * The principal behind a personal token, or null when the token is malformed, unknown, revoked or expired, or its
 * owner left the organization. Every case answers the same 401, so a caller cannot tell which one it hit.
 */
export async function resolveMcpPrincipal(deps: McpPrincipalDeps, token: string | null): Promise<McpPrincipal | null> {
  if (!token || !isMcpTokenFormat(token)) return null;
  // The lookup is by hash, so the secret itself is never compared and its timing reveals nothing.
  const row = await deps.store.findPersonalToken(deps.hash(token));
  const now = deps.now();
  if (!row || row.revokedAt || row.role === null) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
  // Most requests find a recent `lastUsedAt` and skip the round trip.
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) await deps.store.touch(row.id, now);
  return {
    tokenId: row.id,
    tokenName: row.name,
    userId: row.userId,
    organizationId: row.organizationId,
    role: row.role,
    scopes: readScopes(row.scopes),
    policyEpoch: row.policyEpoch,
    expiresAt: row.expiresAt,
  };
}
