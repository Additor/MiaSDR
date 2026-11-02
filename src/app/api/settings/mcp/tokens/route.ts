import { z } from "zod";
import { createMcpToken, listMcpTokens, MCP_TOKEN_ACCESS, MCP_TOKEN_EXTRAS } from "@/contexts/tenancy/application/mcp-tokens";
import { mcpTokenDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { withActor } from "@/app/_lib/api";

/** `?scope=organization` lists every member's tokens for an owner or admin; otherwise the caller's own. */
export const GET = (request: Request) =>
  withActor((actor) => listMcpTokens(mcpTokenDeps(), actor, new URL(request.url).searchParams.get("scope") === "organization" ? "organization" : "mine"));

/** The answer carries `token`, the secret, this once. */
export const POST = (request: Request) =>
  withActor(async (actor) => createMcpToken(mcpTokenDeps(), actor, z.object({ name: z.string(), access: z.enum(MCP_TOKEN_ACCESS).optional(), extras: z.array(z.enum(MCP_TOKEN_EXTRAS)).optional() }).parse(await request.json())), 201);
