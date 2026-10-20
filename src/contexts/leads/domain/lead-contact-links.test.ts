import { describe, expect, it } from "vitest";
import { mailtoHref, profileHref, telHref } from "./lead-contact-links";

describe("mailtoHref", () => {
  it("links an address and refuses anything that is not one", () => {
    expect(mailtoHref("ada@acme.test")).toBe("mailto:ada@acme.test");
    expect(mailtoHref("  ada@acme.test ")).toBe("mailto:ada@acme.test");
    expect(mailtoHref(null)).toBeNull();
    expect(mailtoHref("not an email")).toBeNull();
    expect(mailtoHref('a@b.test"><script>')).toBeNull();
  });
});

describe("telHref", () => {
  it("keeps the plus and the digits", () => {
    expect(telHref("+1 555 0100 123")).toBe("tel:+15550100123");
    expect(telHref("+82 10-1234-5678")).toBe("tel:+821012345678");
    expect(telHref("(555) 010-0123")).toBe("tel:5550100123");
  });
  it("refuses empty and too short values", () => {
    expect(telHref("")).toBeNull();
    expect(telHref(null)).toBeNull();
    expect(telHref("12")).toBeNull();
  });
});

describe("profileHref", () => {
  it("opens http and https profile URLs", () => {
    expect(profileHref("https://www.linkedin.com/in/ada-lovelace/")).toBe("https://www.linkedin.com/in/ada-lovelace/");
  });
  it("never turns another scheme into a link", () => {
    expect(profileHref("javascript:alert(1)")).toBeNull();
    expect(profileHref("data:text/html,x")).toBeNull();
    expect(profileHref("linkedin.com/in/ada")).toBeNull();
    expect(profileHref(null)).toBeNull();
  });
});
