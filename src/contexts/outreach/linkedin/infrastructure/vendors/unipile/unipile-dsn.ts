/** Which DSN hosts may receive the API key, besides `*.unipile.com`. */
export interface DsnPolicy {
  /** Hosts allowed besides `*.unipile.com`: `host`, `host:port` or `*.domain`. */
  allowedHosts: string[];
  /** Lets localhost, 127.0.0.1 and [::1] through, with plain http. Tests and the fake provider only. */
  allowLoopback: boolean;
}

/** `http` only for an allowed loopback host. Everything else is `https`. */
export type DsnScheme = "https" | "http";

const STRICT_DSN_POLICY: DsnPolicy = { allowedHosts: [], allowLoopback: false };
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function hostAllowed(hostname: string, host: string, entries: string[]): boolean {
  if (hostname.endsWith(".unipile.com")) return true;
  return entries.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "") return false;
    if (entry.startsWith("*.")) return hostname.endsWith(entry.slice(1));
    return entry === host || entry === hostname;
  });
}

/**
 * Accepts `https://api1.unipile.com:13111/` or `api1.unipile.com:13111` and returns the bare host with its port, or null.
 * The key is sent to this host, so it must be a Unipile host (or one the operator listed). IP literals, userinfo,
 * paths, non-https schemes and ports outside 1..65535 are refused.
 */
export function normalizeDsn(input: string, policy: DsnPolicy = STRICT_DSN_POLICY): string | null {
  return parseDsn(input, policy)?.host ?? null;
}

/** The single parse of a DSN: the normalized host and the scheme the gateway must use. The gateway never re-derives either. */
export function parseDsn(input: string, policy: DsnPolicy = STRICT_DSN_POLICY): { host: string; scheme: DsnScheme } | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > 255) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase() ?? null;
  if (scheme !== null && scheme !== "https" && scheme !== "http") return null;
  let url: URL;
  try {
    url = new URL(scheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  const hostname = url.hostname.toLowerCase();
  // URL drops a default port and leaves the rest alone, so read the port from the text.
  const authority = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0];
  const port = /:(\d*)$/.exec(authority.replace(/^\[[^\]]*\]/, ""))?.[1];
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return null;
  const host = url.host.toLowerCase();

  if (LOOPBACK.test(hostname)) return policy.allowLoopback ? { host, scheme: "http" } : null;
  // Plain http is for loopback only.
  if (scheme === "http") return null;
  if (hostname.startsWith("[") || /^[0-9.]+$/.test(hostname) || /^0x/i.test(hostname)) return null;
  if (!HOSTNAME.test(hostname)) return null;
  return hostAllowed(hostname, host, policy.allowedHosts) ? { host, scheme: "https" } : null;
}
