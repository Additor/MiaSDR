import { createHash, randomBytes } from "node:crypto";
import type { McpPrincipalDeps } from "../application/mcp-principal";
import type { McpTokenDeps } from "../application/mcp-tokens";
import { MCP_TOKEN_PREFIX } from "../domain/mcp-token";
import { drizzleMcpTokenAdminStore } from "./drizzle-mcp-token-admin-store";
import { drizzleMcpTokenStore } from "./drizzle-mcp-token-store";

export const hashMcpToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** 32 random bytes are 43 base64url characters, the format `isMcpTokenFormat` reads. */
const newMcpSecret = (): string => `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

/** Resolves the principal of an MCP request from its bearer token. */
export const mcpPrincipalDeps = (): McpPrincipalDeps => ({ store: drizzleMcpTokenStore, hash: hashMcpToken, now: () => new Date() });

/** Settings > MCP: the organization's switch and the tokens. */
export const mcpTokenDeps = (): McpTokenDeps => ({ store: drizzleMcpTokenAdminStore, newSecret: newMcpSecret, hash: hashMcpToken, now: () => new Date() });
