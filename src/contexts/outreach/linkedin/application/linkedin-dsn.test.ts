import { describe, expect, it } from "vitest";
import { normalizeDsn } from "./linkedin-management";

const strict = { allowedHosts: [], allowLoopback: false };

describe("normalizeDsn allow-list", () => {
  it.each([
    ["api51.unipile.com:18168", "api51.unipile.com:18168"],
    ["https://API1.unipile.com:13111/", "api1.unipile.com:13111"],
    ["api1.unipile.com", "api1.unipile.com"],
    ["https://api1.unipile.com:443", "api1.unipile.com"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeDsn(input, strict)).toBe(expected);
    expect(normalizeDsn(input)).toBe(expected);
  });

  it.each([
    "169.254.169.254",
    "169.254.169.254:80",
    "10.0.0.5:5432",
    "2130706433",
    "0x7f.1",
    "[fe80::1]:443",
    "attacker.com",
    "unipile.com",
    "evil-unipile.com",
    "api1.unipile.com.attacker.com",
    "https://user@api1.unipile.com",
    "https://user:pw@api1.unipile.com",
    "http://api1.unipile.com",
    "ftp://api1.unipile.com",
    "api1.unipile.com:0",
    "api1.unipile.com:65536",
    "api1.unipile.com:99999999",
    "api1.unipile.com/path",
    "api1.unipile.com?x=1",
    "api1.unipile.com#.unipile.com",
    "https://api1.unipile.com\\@attacker.com",
    "not a host",
    "",
    "localhost:4000",
    "127.0.0.1:4000",
    "http://localhost:4000",
    "[::1]:4000",
  ])("rejects %s", (input) => {
    expect(normalizeDsn(input, strict)).toBeNull();
  });

  it("allows the loopback stand-in only when the policy says so", () => {
    const loopback = { allowedHosts: [], allowLoopback: true };
    expect(normalizeDsn("127.0.0.1:4000", loopback)).toBe("127.0.0.1:4000");
    expect(normalizeDsn("http://localhost:4000", loopback)).toBe("localhost:4000");
    expect(normalizeDsn("10.0.0.5:5432", loopback)).toBeNull();
  });

  it("allows operator-listed hosts and wildcards, still refusing IP literals", () => {
    const policy = { allowedHosts: ["unipile.internal.example.com", "*.proxy.example.org", "gw.example.net:9000", "10.0.0.5"], allowLoopback: false };
    expect(normalizeDsn("unipile.internal.example.com", policy)).toBe("unipile.internal.example.com");
    expect(normalizeDsn("a.proxy.example.org:8443", policy)).toBe("a.proxy.example.org:8443");
    expect(normalizeDsn("gw.example.net:9000", policy)).toBe("gw.example.net:9000");
    expect(normalizeDsn("gw.example.net:9001", policy)).toBeNull();
    expect(normalizeDsn("attacker.com", policy)).toBeNull();
    expect(normalizeDsn("10.0.0.5", policy)).toBeNull();
  });
});
