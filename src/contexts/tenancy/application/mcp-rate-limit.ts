import { MCP_RATE_LIMITS, rateRetryAfterSeconds, rateWindowStart, type McpRateBucket } from "../domain/mcp-rate-limit";
import type { McpPrincipal } from "./mcp-principal";

export interface McpRateLimitStore {
  /** Counts one request in the token's bucket and answers the window's count with it. A new window starts at 1. */
  hit(input: { organizationId: string; tokenId: string; bucket: McpRateBucket; windowStart: Date }): Promise<number>;
}

export interface McpRateLimitDeps {
  store: McpRateLimitStore;
  now: () => Date;
}

/**
 * Counts a request against its token's bucket. Answers null while the token stays within the limit, or the seconds
 * until the window ends. A refused request still counts, so a client that keeps retrying stays refused.
 */
export async function takeMcpRequest(deps: McpRateLimitDeps, principal: Pick<McpPrincipal, "organizationId" | "tokenId">, bucket: McpRateBucket): Promise<{ retryAfterSeconds: number } | null> {
  const now = deps.now();
  const count = await deps.store.hit({ organizationId: principal.organizationId, tokenId: principal.tokenId, bucket, windowStart: rateWindowStart(now) });
  return count > MCP_RATE_LIMITS[bucket] ? { retryAfterSeconds: rateRetryAfterSeconds(now) } : null;
}
