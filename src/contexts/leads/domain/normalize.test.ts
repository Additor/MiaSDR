import { describe, expect, it } from "vitest";
import { customColumnKey, normalizeDomain, normalizeEmail, normalizeLinkedinSlug, normalizePhone } from "./normalize";

describe("normalizeEmail", () => {
  it("lowercases, trims and strips mailto:", () => {
    expect(normalizeEmail("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizeEmail("mailto:a@b.co")).toBe("a@b.co");
  });
  it("rejects non-addresses", () => {
    expect(normalizeEmail("jane")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe("normalizeDomain", () => {
  it.each([
    ["https://www.Acme.com/about?x=1", "acme.com"],
    ["acme.com", "acme.com"],
    ["jane@sub.acme.co.uk", "sub.acme.co.uk"],
    ["http://acme.com:8080/", "acme.com"],
    ["WWW.ACME.COM.", "acme.com"],
  ])("reads %s as %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });
  it("rejects values with no domain", () => {
    expect(normalizeDomain("Acme Inc")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
  });
});

describe("normalizeLinkedinSlug", () => {
  it("reads profile URLs and bare slugs", () => {
    expect(normalizeLinkedinSlug("https://www.linkedin.com/in/Jane-Doe-123/?trk=x")).toBe("jane-doe-123");
    expect(normalizeLinkedinSlug("linkedin.com/in/jane-doe")).toBe("jane-doe");
    expect(normalizeLinkedinSlug("jane-doe")).toBe("jane-doe");
  });
  it("decodes percent-encoded slugs", () => {
    expect(normalizeLinkedinSlug("https://linkedin.com/in/j%C3%B6rg-m")).toBe("jörg-m");
  });
  it("rejects company pages and other URLs", () => {
    expect(normalizeLinkedinSlug("https://www.linkedin.com/company/acme")).toBeNull();
    expect(normalizeLinkedinSlug("https://example.com/in/jane")).toBeNull();
    expect(normalizeLinkedinSlug("two words")).toBeNull();
  });
});

describe("normalizePhone", () => {
  it("keeps a local-format number only when a country is given", () => {
    expect(normalizePhone("010-1234-5678")).toBeNull();
    expect(normalizePhone("+82 10 1234 5678", "US")).toBe("+821012345678");
  });
  it("returns E.164 with a default country", () => {
    expect(normalizePhone("010-1234-5678", "KR")).toBe("+821012345678");
    expect(normalizePhone("+1 (415) 555-2671")).toBe("+14155552671");
  });
  it("returns null for invalid or unparseable numbers", () => {
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("call me")).toBeNull();
  });
});

describe("customColumnKey", () => {
  it("builds a stable x_ key for Latin labels", () => {
    expect(customColumnKey("Lead Source!")).toBe("x_lead_source");
    expect(customColumnKey("Café")).toBe("x_cafe");
  });
  it("keeps non-Latin labels apart with a hash suffix", () => {
    const size = customColumnKey("회사 규모");
    const name = customColumnKey("회사 이름");
    expect(size).toMatch(/^x_c_[a-z0-9]+$/);
    expect(name).toMatch(/^x_c_[a-z0-9]+$/);
    expect(size).not.toBe(name);
    expect(customColumnKey("회사 규모")).toBe(size);
  });
  it("suffixes mixed labels so they do not collide with the Latin part alone", () => {
    expect(customColumnKey("규모 size")).toMatch(/^x_size_[a-z0-9]+$/);
    expect(customColumnKey("size")).toBe("x_size");
  });
  it("matches the column key rule used by the database", () => {
    for (const label of ["Lead Source", "회사 규모", "규모 size", "Größe"]) {
      expect(customColumnKey(label)).toMatch(/^x_[a-z0-9_]+$/);
    }
  });
  it("returns null when the label has no letters or digits", () => {
    expect(customColumnKey("???")).toBeNull();
    expect(customColumnKey("  ")).toBeNull();
  });
});
