import { describe, expect, it } from "vitest";
import { canonicalProfileUrl, parseLinkedinRef } from "./linkedin-url";

describe("parseLinkedinRef", () => {
  it.each([
    ["https://www.linkedin.com/in/Jane-Doe-123/?trk=x", "jane-doe-123"],
    ["http://linkedin.com/in/jane-doe", "jane-doe"],
    ["linkedin.com/in/jane-doe/", "jane-doe"],
    ["www.linkedin.com/in/jane-doe/details/experience/", "jane-doe"],
    ["https://kr.linkedin.com/in/jane-doe", "jane-doe"],
    ["https://www.linkedin.com/in/jane-doe#about", "jane-doe"],
    ["jane-doe", "jane-doe"],
    ["jane.doe", "jane.doe"],
  ])("reads %s as a profile with slug %s", (input, slug) => {
    const ref = parseLinkedinRef(input);
    expect(ref).toEqual({ kind: "profile", slug, url: `https://www.linkedin.com/in/${slug}/` });
  });

  it("encodes non-ASCII slugs in the canonical URL", () => {
    const ref = parseLinkedinRef("https://linkedin.com/in/j%C3%B6rg-m");
    expect(ref).toMatchObject({ kind: "profile", slug: "jörg-m" });
    expect(canonicalProfileUrl("jörg-m")).toBe("https://www.linkedin.com/in/j%C3%B6rg-m/");
  });

  it.each([
    "https://www.linkedin.com/company/acme/",
    "https://www.linkedin.com/pub/jane-doe/1/2/3",
    "https://www.linkedin.com/sales/lead/ACwAAA,NAME_SEARCH",
    "https://www.linkedin.com/sales/people/ACwAAA",
    "https://sales.linkedin.com/in/jane-doe",
    "https://www.linkedin.com/school/mit/",
    "https://www.linkedin.com/",
  ])("keeps %s as given without a slug", (input) => {
    expect(parseLinkedinRef(input)).toEqual({ kind: "other", slug: null, url: input });
  });

  it.each([
    ["https://www.linkedin.com/sales/lead/ACwAAAbCdEfGhIj,NAME_SEARCH", "ACwAAAbCdEfGhIj", "sales_navigator"],
    ["https://www.linkedin.com/sales/people/ACwAAAbCdEfGhIj", "ACwAAAbCdEfGhIj", "sales_navigator"],
    ["https://www.linkedin.com/talent/profile/ACwAAAbCdEfGhIj?x=1", "ACwAAAbCdEfGhIj", "recruiter"],
    ["https://www.linkedin.com/talent/hire/42/profile/ACwAAAbCdEfGhIj", "ACwAAAbCdEfGhIj", "recruiter"],
    ["https://www.linkedin.com/sales/lead/ACwAAAbCdEfGhIj%2CNAME_SEARCH%2Cxyz", "ACwAAAbCdEfGhIj", "sales_navigator"],
    ["https://www.linkedin.com/sales/people/ACwAAAbCdEfGhIj%2cNAME", "ACwAAAbCdEfGhIj", "sales_navigator"],
    ["https://www.linkedin.com/talent/profile/ACwAAAbCdEfGhIj%2CSEARCH", "ACwAAAbCdEfGhIj", "recruiter"],
    ["ACwAAAbCdEfGhIjKlMnOpQ", "ACwAAAbCdEfGhIjKlMnOpQ", "classic"],
  ])("keeps %s as typed and reads its member id", (input, memberId, api) => {
    expect(parseLinkedinRef(input)).toEqual({ kind: "member", slug: null, url: input, memberId, api });
  });

  it.each(["ACostaMaria", "AEvansLee", "ACwAAAbCdEfGhIj", "ACoAAB1XyZ12"])("reads the short bare token %s as a slug", (input) => {
    expect(parseLinkedinRef(input)).toMatchObject({ kind: "profile", slug: input.toLowerCase() });
  });

  it.each([
    "https://example.com/in/jane",
    "https://linkedin.com.evil.com/in/jane",
    "https://evil.com/?u=linkedin.com/in/jane",
    "javascript:alert(1)",
    "two words",
    "",
    "   ",
    null,
    undefined,
    `https://www.linkedin.com/in/${"a".repeat(2100)}`,
  ])("rejects %s", (input) => {
    expect(parseLinkedinRef(input as string | null | undefined)).toBeNull();
  });
});
