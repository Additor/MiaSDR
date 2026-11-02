import { createMcpHandler, readRequestBody, type AuthInfo } from "@modelcontextprotocol/server";
import { connection } from "next/server";
import { apiError } from "@/app/_lib/api-errors";
import { logMcp } from "@/app/_lib/mcp";
import { mcpOAuthAvailable, mcpResourceMetadataUrl } from "@/contexts/identity/domain/mcp-oauth";
import { looksLikeJwt, verifyMcpAccessToken } from "@/contexts/identity/infrastructure/mcp-oauth";
import { resolveMcpAccess, resolveMcpGrant, type McpPrincipal } from "@/contexts/tenancy/application/mcp-principal";
import { takeMcpRequest } from "@/contexts/tenancy/application/mcp-rate-limit";
import { bearerToken, isMcpTokenFormat } from "@/contexts/tenancy/domain/mcp-token";
import { mcpPrincipalDeps, mcpRateLimitDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { env } from "@/shared/env";
import { createMcpServer, recordRefusedCall } from "./_tools/registry";
import { BadTokenLimiter, clientIp } from "./bad-token-limiter";
import { connectionClient, initializingClient, withConnectionId } from "./legacy-connection";

/** Hosted platforms read it; a standalone server ignores it. */
export const maxDuration = 60;

/**
 * The MCP endpoint. The SDK serves 2026-07-28 requests and, statelessly, 2025-11-25 ones from the
 * same server factory, and refuses a request whose `Mcp-Method` or `Mcp-Name` header disagrees with its body (-32020).
 * It verifies no token itself: this handler resolves the bearer token and passes the principal in `authInfo.extra`.
 * The SDK answers its own failures (a factory that throws, a server error, a refused request) without throwing, and
 * reports them only to `onerror`, so `onerror` logs them.
 */
const handler = createMcpHandler(({ authInfo }) => createMcpServer(principalOf(authInfo), env().APP_URL, authInfo?.extra?.connectionClient as string | null), {
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

/** A 401 that tells an MCP client to send a bearer token and, where OAuth is on, where to get one. */
const unauthorized = (config: ReturnType<typeof env>) => {
  const metadata = mcpOAuthAvailable(config.APP_URL, config.MCP_ENABLED) ? `, resource_metadata="${mcpResourceMetadataUrl(config.APP_URL)}"` : "";
  return apiError(401, "Send a valid MiaSDR MCP token as a bearer token.", {}, { headers: { "WWW-Authenticate": `Bearer realm="miasdr"${metadata}` } });
};

/** The access behind a bearer token: a personal token by its hash, or an access token this server signed by its grant. */
async function accessOf(token: string | null) {
  if (token === null || isMcpTokenFormat(token)) return resolveMcpAccess(mcpPrincipalDeps(), token);
  const claims = await verifyMcpAccessToken(token);
  return claims && resolveMcpGrant(mcpPrincipalDeps(), claims);
}

async function serve(request: Request): Promise<Response> {
  await connection();
  const config = env();
  if (!config.MCP_ENABLED) return apiError(404, "Not found");
  if (fromForeignOrigin(request, config.APP_URL)) return apiError(403, "This endpoint does not take requests from other sites.", { code: "foreign_origin" });

  const token = bearerToken(request.headers.get("authorization"));
  // Only a well-formed token costs a lookup, so only a failed one counts against the client's IP. A missing or
  // malformed token answers 401 at no cost and is not counted.
  const guess = token !== null && (isMcpTokenFormat(token) || looksLikeJwt(token));
  const ip = guess ? clientIp(request.headers.get("x-forwarded-for"), config.TRUST_PROXY_HOPS) : null;
  const now = new Date();
  const wait = ip ? badTokens.retryAfter(ip, now) : null;
  if (wait) {
    logMcp("bad token limit", { ip, retryAfterSeconds: wait });
    return tooManyRequests(wait, "Too many requests with an unknown MCP token. Wait, then send a valid one.");
  }

  const access = await accessOf(token);
  if (!access) {
    if (ip) badTokens.record(ip, now);
    // A request with no token is how a client finds out it needs one; only a token that failed is worth a line.
    if (guess) logMcp("token refused", { ip });
    return unauthorized(config);
  }
  if ("refusal" in access) return apiError(403, "MCP is off in this organization. An owner or admin can turn it on.", { code: access.refusal });
  const { principal } = access;
  // Every request counts in `read`. A tool that changes data counts its own buckets once its input is parsed
  // (`registerTools`), so a refusal there reaches the agent as a tool error it can read.
  const limited = await takeMcpRequest(mcpRateLimitDeps(), principal, "read");
  if (limited) {
    logMcp("rate limited", { bucket: "read", organizationId: principal.organizationId, tokenId: principal.tokenId, retryAfterSeconds: limited.retryAfterSeconds });
    return tooManyRequests(limited.retryAfterSeconds, "This MCP token sent too many requests this minute. Wait, then try again.");
  }
  const client = connectionClient(request.headers.get("mcp-session-id"));
  let initializing: string | null = null;
  if (request.method === "POST") {
    // A body over the SDK's limit goes on, and the SDK answers it.
    const body = await readRequestBody(request.clone());
    // The limit above counts requests, so a batch would run many tools for one count. The protocol dropped batches in 2025-06-18.
    if (!body.tooLarge && body.text.trimStart().startsWith("[")) return apiError(400, "Send one JSON-RPC message per request; this endpoint takes no batches.", { code: "batch_not_supported" });
    if (!body.tooLarge) {
      await recordRefusedCall(principal, body.text, client);
      initializing = initializingClient(body.text);
    }
  }
  // The raw token never travels further than this function: `token` carries the token's id.
  const authInfo: AuthInfo = { token: principal.tokenId, clientId: principal.tokenId, scopes: principal.scopes, extra: { principal, connectionClient: client } };
  const response = await handler.fetch(request, { authInfo });
  return initializing && response.ok ? withConnectionId(response, initializing) : response;
}

export const POST = serve;
/** The SDK answers 405 to the 2025 session operations (the id in `legacy-connection.ts` holds no session to end); they reach it only with a valid token. */
export const GET = serve;
export const DELETE = serve;
