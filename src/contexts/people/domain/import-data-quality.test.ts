import { describe, expect, it } from "vitest";
import { CUSTOM_LABEL_MAX, describeCustomLabels, mergeFieldKey } from "./custom-fields";
import { buildCandidates, planImport, suggestMapping, validateMapping, type ExistingPerson, type Mapping } from "./import-plan";
import { inferCompanyDomain, normalizeCompanyLinkedinUrl, resolvePersonNames, splitFullName } from "./normalize";

const stored = (over: Partial<ExistingPerson> = {}): ExistingPerson => ({
  id: "p1", email: "jane@acme.com", linkedinSlug: null, linkedinUrl: null, firstName: null, lastName: null, fullName: null,
  title: null, phone: null, companyId: null, companyDomain: null, custom: {}, raw: null, ...over,
});

describe("splitFullName", () => {
  it.each([
    ["Mary Ann Smith", "Mary", "Ann Smith"],
    ["Jane", "Jane", null],
    ["  Jane    Doe  ", "Jane", "Doe"],
    ["김민수", "김민수", null],
    ["김 민수", "김", "민수"],
  ])("splits %j", (input, first, last) => {
    expect(splitFullName(input)).toEqual({ first, last });
  });
  it("returns nothing for blank input", () => {
    expect(splitFullName("   ")).toEqual({ first: null, last: null });
    expect(splitFullName(null)).toEqual({ first: null, last: null });
  });
});

describe("resolvePersonNames", () => {
  it("splits the full name when both parts are missing", () => {
    expect(resolvePersonNames({ first: null, last: null, full: "Mary Ann Smith" })).toEqual({ firstName: "Mary", lastName: "Ann Smith", fullName: "Mary Ann Smith" });
  });
  it("never overwrites a supplied part", () => {
    expect(resolvePersonNames({ first: "Maria", last: null, full: "Mary Ann Smith" })).toMatchObject({ firstName: "Maria", lastName: "Ann Smith" });
    expect(resolvePersonNames({ first: "Maria", last: "Lopez", full: "Mary Ann Smith" })).toMatchObject({ firstName: "Maria", lastName: "Lopez" });
  });
  it("builds the full name from parts", () => {
    expect(resolvePersonNames({ first: "Jane", last: "Doe", full: null }).fullName).toBe("Jane Doe");
  });
});

describe("inferCompanyDomain", () => {
  it("takes the domain of a work address", () => {
    expect(inferCompanyDomain("jane@acme.com")).toBe("acme.com");
  });
  it.each(["a@gmail.com", "a@naver.com", "a@kakao.com", "a@daum.net", "a@icloud.com", "a@outlook.com", "a@yahoo.com", "a@hanmail.net"])("skips webmail %s", (email) => {
    expect(inferCompanyDomain(email)).toBeNull();
  });
  it("returns null for a value that is not an address", () => {
    expect(inferCompanyDomain("acme.com")).toBeNull();
    expect(inferCompanyDomain(null)).toBeNull();
  });
});

describe("normalizeCompanyLinkedinUrl", () => {
  it("canonicalizes company pages", () => {
    expect(normalizeCompanyLinkedinUrl("linkedin.com/company/Acme-Inc/about/?x=1")).toBe("https://www.linkedin.com/company/acme-inc/");
  });
  it("refuses people and other hosts", () => {
    expect(normalizeCompanyLinkedinUrl("https://linkedin.com/in/jane")).toBeNull();
    expect(normalizeCompanyLinkedinUrl("https://example.com/company/acme")).toBeNull();
  });
});

describe("mergeFieldKey and describeCustomLabels", () => {
  it.each([["Job Title", "jobTitle"], ["job-title", "jobTitle"], ["ARR ($)", "arr"], ["업종", "업종"], ["Plan 2", "plan2"]])("%j gives %j", (label, key) => {
    expect(mergeFieldKey(label)).toBe(key);
  });
  it("returns null without a letter or digit", () => {
    expect(mergeFieldKey("---")).toBeNull();
  });
  it("flags a label over the limit", () => {
    const [issue] = describeCustomLabels(["x".repeat(CUSTOM_LABEL_MAX + 1)]);
    expect(issue.problem).toMatch(/limit is 60/);
    expect(describeCustomLabels(["x".repeat(CUSTOM_LABEL_MAX)])[0].problem).toBeNull();
  });
  it("flags labels that share a key or merge field", () => {
    const issues = describeCustomLabels(["Plan", "plan!", "Job Title", "JobTitle"]);
    expect(issues.map((i) => i.problem === null)).toEqual([true, false, true, false]);
    expect(issues[1].problem).toMatch(/Same merge field as "Plan"/);
  });
});

describe("suggestMapping defaults", () => {
  it("maps unrecognized headers to custom fields and recognized ones to core targets", () => {
    expect(suggestMapping(["Email", "Job Title", "Seniority", "Company LinkedIn URL", "---"])).toEqual({
      Email: "email",
      "Job Title": "title",
      Seniority: "custom:Seniority",
      "Company LinkedIn URL": "company_linkedin",
      "---": "skip",
    });
  });
  it("cuts a long header to the label limit", () => {
    const header = "h".repeat(80);
    expect(suggestMapping([header])[header]).toBe(`custom:${"h".repeat(CUSTOM_LABEL_MAX)}`);
  });
});

describe("validateMapping custom labels", () => {
  it("rejects a label over 60 characters with a clear message", () => {
    const long = "x".repeat(61);
    expect(validateMapping(["Email", long], { Email: "email", [long]: `custom:${long}` })).toMatch(/limit is 60/);
  });
  it("rejects two custom columns with the same key", () => {
    expect(validateMapping(["Email", "Plan", "plan!"], { Email: "email", Plan: "custom:Plan", "plan!": "custom:plan!" })).toMatch(/Same merge field/);
  });
});

describe("import plan: names", () => {
  const nameOnly: Mapping = { Email: "email", Name: "full_name" };
  it("a file with only a Name column fills first and last name", () => {
    const { candidates } = buildCandidates([{ Email: "a@acme.com", Name: "Mary Ann Smith" }, { Email: "b@acme.com", Name: "Kim" }], nameOnly);
    const plan = planImport(candidates, []);
    expect(plan.inserts[0]).toMatchObject({ firstName: "Mary", lastName: "Ann Smith", fullName: "Mary Ann Smith" });
    expect(plan.inserts[1]).toMatchObject({ firstName: "Kim", lastName: null, fullName: "Kim" });
  });
  it("supplied parts win over the split", () => {
    const { candidates } = buildCandidates([{ Email: "a@acme.com", First: "Maria", Name: "Mary Ann Smith" }], { Email: "email", First: "first_name", Name: "full_name" });
    expect(planImport(candidates, []).inserts[0]).toMatchObject({ firstName: "Maria", lastName: "Ann Smith" });
  });
  it("an update fills an empty first name and keeps a stored one", () => {
    const { candidates } = buildCandidates([{ Email: "jane@acme.com", Name: "Janet Roe" }], nameOnly);
    const empty = planImport(candidates, [stored()]);
    expect(empty.updates[0].patch).toMatchObject({ firstName: "Janet", lastName: "Roe", fullName: "Janet Roe" });
    const full = planImport(candidates, [stored({ firstName: "Jane", lastName: "Doe", fullName: "Jane Doe" })]);
    expect(full.updates[0].patch.firstName).toBeUndefined();
    expect(full.updates[0].patch.lastName).toBeUndefined();
    expect(full.updates[0].patch.fullName).toBe("Janet Roe");
  });
});

describe("import plan: company without domain", () => {
  const map: Mapping = { Email: "email", Company: "company_name", Page: "company_linkedin", Site: "company_domain" };
  it("infers the domain from a work email and keeps the name", () => {
    const plan = planImport(buildCandidates([{ Email: "a@acme.com", Company: "Acme Inc" }], map).candidates, []);
    expect(plan.inserts[0].companyDomain).toBe("acme.com");
    expect(plan.companies.get("acme.com")).toBe("Acme Inc");
    expect(plan.inserts[0].raw).toEqual({});
  });
  it("keeps the name on the person when the email is webmail", () => {
    const plan = planImport(buildCandidates([{ Email: "a@gmail.com", Company: "Acme Inc", Page: "https://linkedin.com/company/acme" }], map).candidates, []);
    expect(plan.inserts[0].companyDomain).toBeNull();
    expect(plan.companies.size).toBe(0);
    expect(plan.inserts[0].raw).toEqual({ company: "Acme Inc", company_linkedin_url: "https://www.linkedin.com/company/acme/" });
  });
  it("does not invent a company when the file has no company name", () => {
    const plan = planImport(buildCandidates([{ Email: "a@acme.com" }], map).candidates, []);
    expect(plan.inserts[0].companyDomain).toBeNull();
  });
  it("an explicit domain wins over the email", () => {
    const plan = planImport(buildCandidates([{ Email: "a@other.com", Company: "Acme", Site: "acme.com" }], map).candidates, []);
    expect(plan.inserts[0].companyDomain).toBe("acme.com");
  });
  it("an inferred domain never moves a lead that has a company", () => {
    const candidates = buildCandidates([{ Email: "jane@acme.com", Company: "Acme Inc" }], map).candidates;
    const plan = planImport(candidates, [stored({ companyId: "c1", companyDomain: "holding.com" })]);
    expect(plan.updates.find((u) => u.patch.companyDomain)).toBeUndefined();
    expect(plan.companies.size).toBe(0);
  });
  it("an inferred domain fills a lead without a company", () => {
    const plan = planImport(buildCandidates([{ Email: "jane@acme.com", Company: "Acme Inc" }], map).candidates, [stored()]);
    expect(plan.updates[0].patch.companyDomain).toBe("acme.com");
  });
  it("an explicit domain replaces the stored one", () => {
    const plan = planImport(buildCandidates([{ Email: "jane@acme.com", Site: "new.com" }], map).candidates, [stored({ companyId: "c1", companyDomain: "old.com" })]);
    expect(plan.updates[0].patch.companyDomain).toBe("new.com");
  });
});

describe("import plan: company LinkedIn", () => {
  const map: Mapping = { Email: "email", Site: "company_domain", Page: "company_linkedin" };
  it("targets the company when there is a domain", () => {
    const plan = planImport(buildCandidates([{ Email: "a@x.com", Site: "acme.com", Page: "linkedin.com/company/acme" }], map).candidates, []);
    expect(plan.companyLinkedin.get("acme.com")).toBe("https://www.linkedin.com/company/acme/");
    expect(plan.inserts[0].raw).toEqual({});
  });
  it("warns and ignores a person URL", () => {
    const r = buildCandidates([{ Email: "a@x.com", Site: "acme.com", Page: "https://linkedin.com/in/jane" }], map);
    expect(r.candidates[0].companyLinkedinUrl).toBeNull();
    expect(r.warnings[0].reason).toMatch(/company page/);
  });
});

describe("import plan: extra columns", () => {
  it("stores values of default custom columns under their key", () => {
    const headers = ["Email", "Job Title", "Seniority"];
    const mapping = suggestMapping(headers);
    const r = buildCandidates([{ Email: "a@x.com", "Job Title": "CTO", Seniority: "Senior" }], mapping, { headers });
    expect(r.customColumns).toEqual([{ key: "x_seniority", name: "Seniority" }]);
    expect(r.candidates[0].custom).toEqual({ x_seniority: "Senior" });
    expect(r.candidates[0].title).toBe("CTO");
  });
});
