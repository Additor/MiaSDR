/**
 * SSRF policy for every URL a person can configure on a provider. Two checks:
 * `parseProviderBaseUrl` runs when the provider is saved and again before every call
 * (a row saved under an older, looser rule must not reach the network), and
 * `isBlockedAddress` runs on the addresses DNS returns right before the request.
 * Same shape as the LinkedIn DSN policy: https only, no userinfo, no IP literals,
 * and a host must be on the operator's list. An empty list refuses everything.
 */

export interface UrlPolicy {
  /** `host`, `host:port` or `*.domain`. Compared lower-case. */
  allowedHosts: readonly string[];
  /** Loopback over http, for tests and demos only. */
  allowLoopback?: boolean;
}

export interface ParsedBaseUrl {
  /** Origin plus an optional path prefix, no trailing slash. */
  base: string;
  host: string;
  hostname: string;
  scheme: "https" | "http";
}

const LOOPBACK = /^(localhost|127\.0\.0\.1)$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** An entry without a port allows only the default port; `host:8443` allows exactly that port. */
function hostAllowed(hostname: string, host: string, entries: readonly string[]): boolean {
  return entries.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "") return false;
    const port = /:(\d+)$/.exec(entry)?.[1];
    const pattern = port ? entry.slice(0, -(port.length + 1)) : entry;
    const urlPort = host.slice(hostname.length + 1); // "" when the port is the default
    if ((port ?? "") !== urlPort) return false;
    if (pattern.startsWith("*.")) return hostname.endsWith(pattern.slice(1));
    return pattern === hostname;
  });
}

export function parseProviderBaseUrl(input: string, policy: UrlPolicy): ParsedBaseUrl | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > 300) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  // `new URL` folds dot segments away, so look at the text the person typed.
  if (/%2e|%2f|%5c|\\/i.test(trimmed) || /\/\.{1,2}(\/|$)/.test(trimmed.replace(/^https?:\/\//i, ""))) return null;
  const hostname = url.hostname.toLowerCase();
  const host = url.host.toLowerCase();
  const scheme = url.protocol === "https:" ? "https" : "http";
  const path = url.pathname.replace(/\/+$/, "");
  const make = (): ParsedBaseUrl => ({ base: `${scheme}://${host}${path}`, host, hostname, scheme });

  if (LOOPBACK.test(hostname)) return policy.allowLoopback ? make() : null;
  if (scheme !== "https") return null;
  if (hostname.startsWith("[") || /^[0-9.]+$/.test(hostname) || /^0x/i.test(hostname)) return null;
  if (!HOSTNAME.test(hostname)) return null;
  return hostAllowed(hostname, host, policy.allowedHosts) ? make() : null;
}

export { isBlockedAddress } from "@/shared/blocked-address";

/** Header names a provider config may set. Rejects line breaks and anything that is not a token. */
export const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** Query parameter names for an API key sent in the URL. */
export const QUERY_PARAM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Header values carry no line breaks (header injection). */
export const stripLineBreaks = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
