import { describe, expect, it } from "vitest";
import { checkCompanyDomain, companyLabel, renameOnCompanyPage } from "./company-domain";

describe("checkCompanyDomain", () => {
  it("normalizes a website, an email address or a domain", () => {
    expect(checkCompanyDomain("https://www.Acme.com/about?x=1")).toEqual({ domain: "acme.com", issue: null });
    expect(checkCompanyDomain(" ACME.com. ")).toEqual({ domain: "acme.com", issue: null });
    expect(checkCompanyDomain("ada@acme.co.kr")).toEqual({ domain: "acme.co.kr", issue: null });
  });

  it("refuses a value that is not a domain", () => {
    expect(checkCompanyDomain("not a domain")).toEqual({ domain: null, issue: '"not a domain" is not a company domain or website.' });
    expect(checkCompanyDomain("  ")).toEqual({ domain: null, issue: '"" is not a company domain or website.' });
  });

  it("refuses a webmail domain after normalizing it", () => {
    expect(checkCompanyDomain("https://www.Gmail.com")).toEqual({ domain: null, issue: "gmail.com is an email provider, not a company domain." });
    expect(checkCompanyDomain("someone@naver.com").issue).toBe("naver.com is an email provider, not a company domain.");
  });
});

describe("company copy", () => {
  it("names a company by its name, else its domain", () => {
    expect(companyLabel({ name: "Acme", domain: "acme.com" })).toBe("Acme");
    expect(companyLabel({ name: null, domain: "acme.com" })).toBe("acme.com");
    expect(renameOnCompanyPage({ name: "Acme", domain: "acme.com" })).toBe("Rename Acme on its company page.");
  });
});
