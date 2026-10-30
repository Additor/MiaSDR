import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { connection } from "next/server";
import { apiError } from "@/app/_lib/api-errors";
import { resolveMcpAccess, type McpPrincipal } from "@/contexts/tenancy/application/mcp-principal";
import { takeMcpRequest } from "@/contexts/tenancy/application/mcp-rate-limit";
import { bearerToken, isMcpTokenFormat } from "@/contexts/tenancy/domain/mcp-token";
import { mcpPrincipalDeps, mcpRateLimitDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { env } from "@/shared/env";
import { createMcpServer } from "./_tools/registry";
import { BadTokenLimiter, clientIp } from "./bad-token-limiter";

/** Hosted platforms read it; a standalone server ignores it. */
export const maxDuration = 60;

/**
 * The MCP endpoint. The SDK serves 2026-07-28 requests and, statelessly, 2025-11-25 ones from the
 * same server factory, and refuses a request whose `Mcp-Method` or `Mcp-Name` header disagrees with its body (-32020).
 * It verifies no token itself: this handler resolves the bearer token and passes the principal in `authInfo.extra`.
 * The SDK answers its own failures (a factory that throws, a server error, a refused request) without throwing, and
 * reports them only to `onerror`, so `onerror` logs them.
 */
const handler = createMcpHandler(({ authInfo }) => createMcpServer(principalOf(authInfo), env().APP_URL), {
  legacy: "stateless",
  responseMode: "json",
  onerror: (error) => console.error("[mcp] request failed", error),
});

function principalOf(authInfo: AuthInfo | undefined): McpPrincipal {
  const principal = authInfo?.extra?.principal as McpPrincipal | undefined;
  // The handler below passes a principal on every request, so a missing one means this route is wired wrong.
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

const badTokens = new BadTokenLimiter();

/** A 429 with `Retry-After`. */
const tooManyRequests = (retryAfterSeconds: number, message: string) =>
  apiError(429, message, { retryAfterSeconds }, { headers: { "Retry-After": String(retryAfterSeconds) } });

/** A 401 that tells an MCP client to send a bearer token. */
const unauthorized = () => apiError(401, "Send a valid MiaSDR MCP token as a bearer token.", {}, { headers: { "WWW-Authenticate": 'Bearer realm="miasdr"' } });

async function serve(request: Request): Promise<Response> {
  await connection();
  const config = env();
  if (!config.MCP_ENABLED) return apiError(404, "Not found");
  if (fromForeignOrigin(request, config.APP_URL)) return apiError(403, "This endpoint does not take requests from other sites.", { code: "foreign_origin" });

  const token = bearerToken(request.headers.get("authorization"));
  // Only a well-formed token costs a lookup, so only a failed one counts against the client's IP. A missing or
  // malformed token answers 401 at no cost and is not counted.
  const guess = token !== null && isMcpTokenFormat(token);
  const ip = guess ? clientIp(request.headers.get("x-forwarded-for"), config.TRUST_PROXY_HOPS) : null;
  const now = new Date();
  const wait = ip ? badTokens.retryAfter(ip, now) : null;
  if (wait) return tooManyRequests(wait, "Too many requests with an unknown MCP token. Wait, then send a valid one.");

  const access = await resolveMcpAccess(mcpPrincipalDeps(), token);
  if (!access) {
    if (ip) badTokens.record(ip, now);
    return unauthorized();
  }
  if ("refusal" in access) return apiError(403, "MCP is off in this organization. An owner or admin can turn it on.", { code: access.refusal });
  const { principal } = access;
  // Every request counts in `read`. A tool that changes data counts its own buckets once its input is parsed
  // (`registerTools`), so a refusal there reaches the agent as a tool error it can read.
  const limited = await takeMcpRequest(mcpRateLimitDeps(), principal, "read");
  if (limited) return tooManyRequests(limited.retryAfterSeconds, "This MCP token sent too many requests this minute. Wait, then try again.");
  // The raw token never travels further than this function: `token` carries the token's id.
  const authInfo: AuthInfo = { token: principal.tokenId, clientId: principal.tokenId, scopes: principal.scopes, extra: { principal } };
  return handler.fetch(request, { authInfo });
}

export const POST = serve;
/** The SDK answers 405 to the 2025 session operations; they reach it only with a valid token. */
export const GET = serve;
export const DELETE = serve;
