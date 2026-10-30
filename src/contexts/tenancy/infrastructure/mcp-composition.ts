import { createHash } from "node:crypto";
import type { McpPrincipalDeps } from "../application/mcp-principal";
import { drizzleMcpTokenStore } from "./drizzle-mcp-token-store";

export const hashMcpToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Resolves the principal of an MCP request from its bearer token. */
export const mcpPrincipalDeps = (): McpPrincipalDeps => ({ store: drizzleMcpTokenStore, hash: hashMcpToken, now: () => new Date() });
