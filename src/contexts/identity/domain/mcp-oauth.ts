/**
 * Where MCP OAuth lives on an install. `@better-auth/mcp` refuses a resource that is neither HTTPS nor loopback, and no
 * remote client could reach such an address anyway, so an install on plain HTTP serves personal tokens only.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function mcpOAuthAvailable(appUrl: string, mcpEnabled: boolean): boolean {
  if (!mcpEnabled) return false;
  const { protocol, hostname } = new URL(appUrl);
  return protocol === "https:" || LOOPBACK.has(hostname);
}

export const mcpResourceUrl = (appUrl: string): string => `${appUrl}/api/mcp`;
export const mcpIssuerUrl = (appUrl: string): string => `${appUrl}/api/auth`;
export const mcpResourceMetadataUrl = (appUrl: string): string => `${appUrl}/.well-known/oauth-protected-resource/api/mcp`;

/** The access token claim that names the organization the person chose. */
export const MCP_ORG_CLAIM = "org_id";

/** The scopes an MCP client may ask for. `offline_access` lets it refresh without sending the person back here. */
export const MCP_OAUTH_SCOPES = ["mcp:read", "mcp:write", "mcp:send", "mcp:spend", "mcp:irreversible", "offline_access"] as const;

export const CONSENT_PAGE = "/oauth/consent";
