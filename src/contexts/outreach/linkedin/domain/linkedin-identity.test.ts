import { describe, expect, it } from "vitest";
import { parseLinkedinRef } from "@/contexts/leads/domain/linkedin-url";
import { canonicalProfileUrl, isMemberReference, normalizePublicSlug, parseLinkedInProfileRef, resultMemberId } from "./linkedin-identity";

const ID = "ACwAAAbCdEfGhIjKlMnOp";

describe("parseLinkedInProfileRef", () => {
  it.each([
    ["https://www.linkedin.com/in/Jane-Doe/", "jane-doe"],
    ["https://www.linkedin.com/in/jane-doe", "jane-doe"],
    ["https://de.linkedin.com/in/jane-doe/?trk=x", "jane-doe"],
    ["linkedin.com/in/JANE", "jane"],
    ["jane-doe", "jane-doe"],
  ])("reads %s as the public slug %s", (input, slug) => {
    expect(parseLinkedInProfileRef(input)).toEqual({ kind: "public", slug });
  });

  it.each([
    [`https://www.linkedin.com/sales/lead/${ID},NAME_SEARCH,xyz`, "sales_navigator", ID],
    [`https://www.linkedin.com/sales/lead/${ID}?trk=x`, "sales_navigator", ID],
    [`https://www.linkedin.com/sales/lead/${ID}`, "sales_navigator", ID],
    [`https://www.linkedin.com/sales/people/${ID}/`, "sales_navigator", ID],
    ["https://www.linkedin.com/sales/lead/acwaaabcdefghijklmn,NAME", "sales_navigator", "acwaaabcdefghijklmn"],
    ["https://www.linkedin.com/sales/lead/AcWaAaBcDeFgHiJ,NAME", "sales_navigator", "AcWaAaBcDeFgHiJ"],
    [`https://www.linkedin.com/talent/profile/${ID}`, "recruiter", ID],
    [`https://www.linkedin.com/talent/hire/123456/profile/${ID}?x=1`, "recruiter", ID],
    [`https://www.linkedin.com/sales/lead/${ID}%2CNAME_SEARCH%2Cxyz`, "sales_navigator", ID],
    [`https://www.linkedin.com/sales/people/${ID}%2cNAME`, "sales_navigator", ID],
    [`https://www.linkedin.com/talent/profile/${ID}%2CSEARCH`, "recruiter", ID],
    [ID, "classic", ID],
    ["ACoAAB1XyZ12345678901", "classic", "ACoAAB1XyZ12345678901"],
    ["AEAAAB1XyZ12345678901", "classic", "AEAAAB1XyZ12345678901"],
  ])("reads %s as a member id", (input, api, memberId) => {
    expect(parseLinkedInProfileRef(input)).toEqual({ kind: "member", api, memberId });
  });

  it.each([
    ["an id shorter than 10 characters", "https://www.linkedin.com/sales/lead/ACwAAA"],
    ["a company page", "https://www.linkedin.com/company/acme/"],
    ["a /pub/ page", "https://www.linkedin.com/pub/jane-doe/1/2/3"],
    ["a non-LinkedIn host", `https://example.com/sales/lead/${ID}`],
    ["a look-alike host", `https://linkedin.com.evil.com/sales/lead/${ID}`],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["text with spaces", "two words"],
    ["an id with unsafe characters", "https://www.linkedin.com/sales/lead/ACwAAA%20bCdEfGhIj"],
  ])("returns null for %s", (_name, input) => {
    expect(parseLinkedInProfileRef(input)).toBeNull();
  });
});

describe("bare tokens that look like provider ids", () => {
  it.each(["ACostaMaria", "AEvansLee", "ACoAAB1Xy", "ACoAAB1XyZ12", "ACwAAAbCdEfGhIj"])("reads %s as a slug", (input) => {
    expect(parseLinkedInProfileRef(input)).toEqual({ kind: "public", slug: input.toLowerCase() });
  });
});

describe("normalizePublicSlug", () => {
  it("lowercases and decodes like the leads context", () => {
    expect(normalizePublicSlug("Jane-Doe")).toBe("jane-doe");
    expect(normalizePublicSlug("J%C3%B6rg-M")).toBe("jörg-m");
    expect(normalizePublicSlug("  ")).toBeNull();
    expect(normalizePublicSlug(null)).toBeNull();
  });
});

describe("the outreach and leads parsers agree", () => {
  const long = "ACwAAAbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const inputs = [
    "ACostaMaria", "AEvansLee", "ACwAAAbCdEfGhIj", "ACoAAB1XyZ12", long, "ACwAAAbCdEfGhIjKlMn", "ACwAAAbCdEfGhIjKlMnO",
    "jane-doe", "Jane-Doe", "https://www.linkedin.com/in/Jane-Doe/",
    `https://www.linkedin.com/sales/lead/${long},NAME_SEARCH,x`,
    `https://www.linkedin.com/sales/lead/${long}%2CNAME_SEARCH%2Cxyz`,
    `https://www.linkedin.com/sales/people/${long}`,
    `https://www.linkedin.com/talent/profile/${long}?x=1`,
    `https://www.linkedin.com/talent/hire/42/profile/${long}%2cx`,
    "https://www.linkedin.com/sales/lead/ACwAAA", "https://www.linkedin.com/company/acme/", "https://example.com/in/jane",
  ];
  it.each(inputs)("classifies %s the same way", (input) => {
    const outreach = parseLinkedInProfileRef(input);
    const leads = parseLinkedinRef(input);
    if (outreach?.kind === "member") expect(leads).toMatchObject({ kind: "member", memberId: outreach.memberId, api: outreach.api });
    else if (outreach?.kind === "public") expect(leads).toMatchObject({ kind: "profile", slug: outreach.slug });
    else expect(leads?.kind === "profile" || leads?.kind === "member").toBe(false);
  });
});

describe("resultMemberId", () => {
  it("reads a bare id, a classic /in/<id> link and a Sales Navigator link", () => {
    expect(resultMemberId({ identifier: ID, profileUrl: null })).toBe(ID);
    expect(resultMemberId({ identifier: "x", profileUrl: `https://www.linkedin.com/in/${ID}` })).toBe(ID);
    expect(resultMemberId({ identifier: "x", profileUrl: `https://www.linkedin.com/sales/lead/${ID},NAME` })).toBe(ID);
  });
  it("returns null when there is no member id", () => {
    expect(resultMemberId({ identifier: "not a profile", profileUrl: "https://www.linkedin.com/company/acme" })).toBeNull();
    expect(resultMemberId({ identifier: "jane-doe", profileUrl: null })).toBeNull();
  });
});

describe("helpers", () => {
  it("builds the canonical URL the leads context stores", () => {
    expect(canonicalProfileUrl("jörg-m")).toBe("https://www.linkedin.com/in/j%C3%B6rg-m/");
  });
  it("flags only member references as replaceable", () => {
    expect(isMemberReference(`https://www.linkedin.com/sales/lead/${ID},X`)).toBe(true);
    expect(isMemberReference(ID)).toBe(true);
    expect(isMemberReference("https://www.linkedin.com/in/jane/")).toBe(false);
    expect(isMemberReference(null)).toBe(false);
  });
});
