import { describe, expect, it } from "vitest";
import { isBlockedAddress, parseProviderBaseUrl } from "./enrichment-url-policy";

const policy = { allowedHosts: ["api.vendor.test", "*.partner.test", "api.vendor.test:8443"] };

describe("provider base URL policy", () => {
  it("accepts an https host on the allow-list, with an optional path prefix", () => {
    expect(parseProviderBaseUrl("https://api.vendor.test", policy)?.base).toBe("https://api.vendor.test");
    expect(parseProviderBaseUrl("https://API.vendor.test/v2/", policy)?.base).toBe("https://api.vendor.test/v2");
    expect(parseProviderBaseUrl("https://eu.partner.test", policy)?.host).toBe("eu.partner.test");
    expect(parseProviderBaseUrl("https://api.vendor.test:8443", policy)?.host).toBe("api.vendor.test:8443");
  });

  it("refuses every host when the list is empty", () => {
    expect(parseProviderBaseUrl("https://api.vendor.test", { allowedHosts: [] })).toBeNull();
  });

  it.each([
    ["host not on the list", "https://evil.test"],
    ["suffix trick", "https://api.vendor.test.evil.test"],
    ["plain http", "http://api.vendor.test"],
    ["userinfo", "https://user:pw@api.vendor.test"],
    ["userinfo trick", "https://api.vendor.test@evil.test"],
    ["query", "https://api.vendor.test/?a=1"],
    ["fragment", "https://api.vendor.test/#x"],
    ["IPv4 literal", "https://169.254.169.254"],
    ["decimal IPv4", "https://2130706433"],
    ["hex IPv4", "https://0x7f.1"],
    ["IPv6 literal", "https://[::1]"],
    ["loopback name", "https://localhost"],
    ["loopback over http", "http://127.0.0.1:3000"],
    ["file scheme", "file:///etc/passwd"],
    ["no scheme", "api.vendor.test"],
    ["dot segments", "https://api.vendor.test/a/../b"],
    ["encoded slash", "https://api.vendor.test/a%2Fb"],
    ["single label", "https://intranet"],
    ["wrong port", "https://api.vendor.test:9999"],
  ])("refuses %s", (_name, url) => {
    expect(parseProviderBaseUrl(url, policy)).toBeNull();
  });

  it("allows loopback only when the policy says so", () => {
    expect(parseProviderBaseUrl("http://127.0.0.1:4010", { allowedHosts: [], allowLoopback: true })?.scheme).toBe("http");
    expect(parseProviderBaseUrl("http://127.0.0.1:4010", { allowedHosts: [] })).toBeNull();
  });
});

describe("resolved address check", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1", "not-an-ip", ""])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ["TEST-NET-1", "192.0.2.1"],
    ["TEST-NET-1 edge", "192.0.2.255"],
    ["TEST-NET-2", "198.51.100.7"],
    ["TEST-NET-3", "203.0.113.250"],
    ["IETF protocol assignments", "192.0.0.8"],
    ["6to4 relay anycast", "192.88.99.1"],
    ["benchmarking low", "198.18.0.1"],
    ["benchmarking high", "198.19.255.254"],
    ["reserved class E", "240.0.0.1"],
    ["reserved class E edge", "255.255.255.254"],
    ["broadcast", "255.255.255.255"],
    ["CGNAT low", "100.64.0.1"],
    ["CGNAT high", "100.127.255.254"],
    ["IPv6 documentation", "2001:db8::1"],
    ["IPv6 documentation upper", "2001:db8:ffff::1"],
    ["Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["Teredo short", "2001::1"],
    ["NAT64 to TEST-NET-1", "64:ff9b::c000:201"],
    ["NAT64 dotted to loopback", "64:ff9b::127.0.0.1"],
    ["NAT64 local-use", "64:ff9b:1::1"],
    ["6to4 of 10.0.0.1", "2002:a00:1::"],
    ["6to4 of TEST-NET-3", "2002:cb00:7101::1"],
    ["mapped TEST-NET-2", "::ffff:198.51.100.1"],
    ["mapped hex loopback", "::ffff:7f00:1"],
    ["IPv4-translated loopback", "::ffff:0:127.0.0.1"],
    ["compatible private", "::10.0.0.1"],
    ["site-local", "fec0::1"],
    ["discard prefix", "100::1"],
  ])("blocks %s (%s)", (_name, ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ["just below CGNAT", "100.63.255.255"],
    ["just above CGNAT", "100.128.0.1"],
    ["just below benchmarking", "198.17.255.255"],
    ["just above benchmarking", "198.20.0.1"],
    ["next to TEST-NET-1", "192.0.3.1"],
    ["next to TEST-NET-3", "203.0.114.1"],
    ["public IPv6 next to 2001:db8", "2001:db9::1"],
    ["public 2001 prefix", "2001:4860:4860::8888"],
    ["NAT64 of public address", "64:ff9b::808:808"],
    ["6to4 of public address", "2002:808:808::1"],
  ])("allows %s (%s)", (_name, ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});
