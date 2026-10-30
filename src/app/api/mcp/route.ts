import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { connection } from "next/server";
import { apiError } from "@/app/_lib/api-errors";
import { resolveMcpPrincipal, type McpPrincipal } from "@/contexts/tenancy/application/mcp-principal";
import { bearerToken } from "@/contexts/tenancy/domain/mcp-token";
import { mcpPrincipalDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { env } from "@/shared/env";
import { createMcpServer } from "./_tools/registry";

/** Hosted platforms read it; a standalone server ignores it. */
export const maxDuration = 60;

/**
 * The MCP endpoint. The SDK serves 2026-07-28 requests and, statelessly, 2025-11-25 ones from the
 * same server factory, and refuses a request whose `Mcp-Method` or `Mcp-Name` header disagrees with its body (-32020).
 * It verifies no token itself: this handler resolves the bearer token and passes the principal in `authInfo.extra`.
 */
const handler = createMcpHandler(({ authInfo }) => createMcpServer(principalOf(authInfo)), { legacy: "stateless", responseMode: "json" });

function principalOf(authInfo: AuthInfo | undefined): McpPrincipal {
  const principal = authInfo?.extra?.principal as McpPrincipal | undefined;
  // The handler below passes a principal on every request, so a missing one is a wiring bug, not a caller's mistake.
  if (!principal) throw new Error("MCP request reached the server factory without a principal");
  return principal;
}

/**
 * True when a browser page on another site sent the request. Clients that are not browsers send no Origin and pass.
 * The whole origin must match `APP_URL`, scheme and port included; the SDK's `originValidationResponse` compares the
 * hostname only, which would let another port on the same host through.
 */
function fromForeignOrigin(request: Request, appOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin !== appOrigin;
  } catch {
    return true;
  }
}

/** A 401 that tells an MCP client to send a bearer token. */
const unauthorized = () => apiError(401, "Send a valid MiaSDR MCP token as a bearer token.", {}, { headers: { "WWW-Authenticate": 'Bearer realm="miasdr"' } });

async function serve(request: Request): Promise<Response> {
  await connection();
  const config = env();
  if (!config.MCP_ENABLED) return apiError(404, "Not found");
  if (fromForeignOrigin(request, config.APP_URL)) return apiError(403, "This endpoint does not take requests from other sites.", { code: "foreign_origin" });

  const deps = mcpPrincipalDeps();
  const principal = await resolveMcpPrincipal(deps, bearerToken(request.headers.get("authorization")));
  if (!principal) return unauthorized();
  if (!(await deps.store.settings(principal.organizationId)).enabled) {
    return apiError(403, "MCP is off in this organization. An owner or admin can turn it on.", { code: "mcp_disabled" });
  }
  // The raw token never travels further than this function: `token` carries the token's id.
  const authInfo: AuthInfo = { token: principal.tokenId, clientId: principal.tokenId, scopes: principal.scopes, extra: { principal } };
  return handler.fetch(request, { authInfo });
}

export const POST = serve;
/** The SDK answers 405 to the 2025 session operations; they reach it only with a valid token. */
export const GET = serve;
export const DELETE = serve;
