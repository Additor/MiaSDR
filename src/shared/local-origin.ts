/** True for an IPv4 literal in a range nothing on the internet can reach. */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  // 100.64.0.0/10 is carrier-grade NAT, which includes Tailscale addresses.
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** True for loopback, private, CGNAT, link-local and container-internal hosts, including single-label names such as a compose service (`mia`). An unparseable URL counts as local. */
export function isLocalOrigin(url: string): boolean {
  let host: string;
  try {
    // WHATWG URL keeps the brackets on an IPv6 literal.
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return true;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "host.docker.internal") return true;
  if (isPrivateIpv4(host)) return true;
  // A name without a dot cannot be a public DNS name. It resolves only inside a container network or a LAN.
  if (!host.includes(".") && !host.includes(":")) return true;
  if (host.includes(":")) {
    // URL rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  return false;
}
