/**
 * The shape of a personal MCP token: `msdr_pat_` and 32 random bytes in base64url. The prefix lets secret scanners
 * find a leaked token. Only the hash is stored; the hint is the last four characters, shown to tell tokens apart.
 */
export const MCP_TOKEN_PREFIX = "msdr_pat_";
const SECRET_LENGTH = 43;
const FORMAT = new RegExp(`^${MCP_TOKEN_PREFIX}[A-Za-z0-9_-]{${SECRET_LENGTH}}$`);

/** Days a new personal token lives before it expires. */
export const MCP_TOKEN_DAYS = 90;

export const isMcpTokenFormat = (value: string): boolean => FORMAT.test(value);

export const mcpTokenHint = (token: string): string => token.slice(-4);

/** The token in an `Authorization: Bearer` header, or null when the header is missing or carries another scheme. */
export function bearerToken(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1] : null;
}

/** One OAuth grant: an app, a person and the organization they chose. A refresh stays on the same grant. */
export const mcpGrantId = (organizationId: string, userId: string, clientId: string): string => `${organizationId}:${userId}:${clientId}`;

/** Live tokens one person may hold in one organization. A revoked or expired token does not count. */
export const MCP_TOKEN_LIMIT = 10;

export const MCP_TOKEN_NAME_MAX = 100;

/** Why a token name is not allowed, as a sentence, or null. The name tells a person's tokens apart in lists and logs. */
export function mcpTokenNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Name the token, for example after the laptop or the agent that uses it.";
  if (trimmed.length > MCP_TOKEN_NAME_MAX) return `Keep the token name to ${MCP_TOKEN_NAME_MAX} characters.`;
  return null;
}
