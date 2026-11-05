/**
 * The addresses a server-side request must not reach. Pure, so a policy and a transport can both use it.
 */

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
