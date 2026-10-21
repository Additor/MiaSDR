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

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/** Special-use IPv4 ranges (RFC 6890 and friends) as [first octets..., prefix length]. */
const BLOCKED_IPV4: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10], // CGNAT
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16], // link-local, cloud metadata
  [172, 16, 0, 0, 12],
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // TEST-NET-1
  [192, 88, 99, 0, 24], // 6to4 relay anycast
  [192, 168, 0, 0, 16],
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // TEST-NET-2
  [203, 0, 113, 0, 24], // TEST-NET-3
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved, includes broadcast
];

function blockedIpv4(octets: number[]): boolean {
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  return BLOCKED_IPV4.some(([a, b, c, d, bits]) => {
    const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

function ipv6Groups(ip: string): number[] | null {
  let text = ip.split("%")[0].toLowerCase();
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = ipv4Octets(dotted[2]);
    if (!v4) return null;
    text = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : null;
}

const isIpv4 = (s: string) => ipv4Octets(s) !== null;
const isIpv6 = (s: string) => s.includes(":") && ipv6Groups(s) !== null;

/**
 * True for an address a configured URL must not reach: loopback, private, link-local (cloud metadata),
 * CGNAT, documentation and benchmarking ranges, reserved, unspecified, multicast, Teredo, and IPv6 forms that embed such an IPv4 address. Anything unparseable is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0];
  if (isIpv4(ip)) return blockedIpv4(ipv4Octets(ip)!);
  if (isIpv6(ip)) {
    const g = ipv6Groups(ip)!;
    const embedded = (hi: number, lo: number) => blockedIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    if (g.every((n) => n === 0)) return true;
    if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true;
    // ::/96 (compatible), ::ffff:0:0/96 (mapped) and ::ffff:0:0:0/96 (translated) carry an IPv4 address in the last 32 bits.
    if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded(g[6], g[7]);
    if (g.slice(0, 4).every((n) => n === 0) && g[4] === 0xffff && g[5] === 0) return embedded(g[6], g[7]);
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return embedded(g[6], g[7]);
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
    if (g[0] === 0x2002) return embedded(g[1], g[2]);
    if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo 2001::/32
    if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation 2001:db8::/32
    if (g[0] === 0x100 && g.slice(1, 4).every((n) => n === 0)) return true; // discard-only 100::/64
    if ((g[0] & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
    if ((g[0] & 0xfe00) === 0xfc00) return true;
    if ((g[0] & 0xffc0) === 0xfe80) return true;
    if ((g[0] & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

/** Header names a provider config may set. Rejects line breaks and anything that is not a token. */
export const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** Query parameter names for an API key sent in the URL. */
export const QUERY_PARAM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Header values carry no line breaks (header injection). */
export const stripLineBreaks = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
