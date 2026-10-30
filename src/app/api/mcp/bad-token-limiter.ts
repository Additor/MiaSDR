import { MCP_BAD_TOKEN_LIMIT, rateRetryAfterSeconds, rateWindowStart } from "@/contexts/tenancy/domain/mcp-rate-limit";

/** Client IPs one process remembers. Past this, the IP seen longest ago is dropped. */
const MAX_IPS = 10_000;

/**
 * The client IP `hops` entries from the right of `X-Forwarded-For`: each trusted proxy appends the address it received
 * the request from, so the entries further left are whatever the client wrote. Null without hops, or when the header
 * holds fewer entries than hops.
 */
export function clientIp(forwardedFor: string | null, hops: number | undefined): string | null {
  if (!hops || !forwardedFor) return null;
  const entries = forwardedFor.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length >= hops ? entries[entries.length - hops] : null;
}

/**
 * Failed guesses at a well-formed MCP token, per client IP, in one-minute windows. It lives in process memory: each
 * instance keeps its own count, which still slows a guesser by orders of magnitude, and a restart forgets it.
 */
export class BadTokenLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  /** Seconds until this IP may guess again, or null while it is under the limit. */
  retryAfter(ip: string, now: Date): number | null {
    const window = this.windows.get(ip);
    if (!window || window.start !== rateWindowStart(now).getTime()) return null;
    return window.count >= MCP_BAD_TOKEN_LIMIT ? rateRetryAfterSeconds(now) : null;
  }

  record(ip: string, now: Date): void {
    const start = rateWindowStart(now).getTime();
    const window = this.windows.get(ip);
    const count = window && window.start === start ? window.count + 1 : 1;
    // Delete first, so the IP moves to the end of the insertion order and the oldest stays first to evict.
    this.windows.delete(ip);
    this.windows.set(ip, { start, count });
    // The first key is the IP seen longest ago.
    if (this.windows.size > MAX_IPS) this.windows.delete(this.windows.keys().next().value!);
  }
}
