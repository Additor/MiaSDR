import { describe, expect, it } from "vitest";
import { isSameSite, parsePageUrl, sameSiteLinks } from "../page-url";

describe("parsePageUrl", () => {
  it("takes a public https address and drops its fragment", () => {
    expect(parsePageUrl("https://acme.com/pricing#plans")?.href).toBe("https://acme.com/pricing");
  });

  it.each(["http://acme.com", "https://1.2.3.4/", "https://[::1]/", "https://u:p@acme.com/", "https://acme.com:6443/", "https://localhost/", "https://intranet/", "ftp://acme.com/", "not a url", ""])("refuses %s", (raw) => {
    expect(parsePageUrl(raw)).toBeNull();
  });

  it("resolves a relative link against its page", () => {
    expect(parsePageUrl("/about", "https://acme.com/pricing")?.href).toBe("https://acme.com/about");
  });
});

describe("isSameSite", () => {
  const u = (s: string) => new URL(s);
  it("treats www as the same site", () => {
    expect(isSameSite(u("https://www.acme.com/"), u("https://acme.com/x"))).toBe(true);
  });
  it("treats a subdomain as another site, since strangers share a host like vercel.app", () => {
    expect(isSameSite(u("https://a.vercel.app/"), u("https://b.vercel.app/"))).toBe(false);
    expect(isSameSite(u("https://blog.acme.com/"), u("https://acme.com/"))).toBe(false);
  });
});

describe("sameSiteLinks", () => {
  const page = new URL("https://acme.com/");
  it("keeps the site's links once each, without the page itself or other sites", () => {
    expect(sameSiteLinks(["/pricing", "/pricing#a", "https://evil.test/x", "https://acme.com/", "mailto:a@acme.com", "javascript:alert(1)"], page, 10)).toEqual(["https://acme.com/pricing"]);
  });
  it("stops at the limit", () => {
    expect(sameSiteLinks(["/a", "/b", "/c"], page, 2)).toHaveLength(2);
  });
});
