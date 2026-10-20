import { describe, expect, it } from "vitest";
import { buildVariables, sampleVariables, unresolvedTokens } from "./variables";

const person = {
  firstName: "Ann", lastName: "Lee", fullName: "Ann Lee", title: "CTO", phone: null, email: "ann@acme.com",
  companyName: null, companyDomain: "acme.com", custom: { x_c_1: "SaaS", x_other: 5 },
};

describe("buildVariables", () => {
  it("falls back to the domain when the company has no name", () => {
    expect(buildVariables(person, new Map()).company).toBe("acme.com");
  });
  it("exposes custom values under their label and ignores non-text values", () => {
    const vars = buildVariables(person, new Map([["x_c_1", "업종"]]));
    expect(vars["업종"]).toBe("SaaS");
    expect(vars.x_other).toBeUndefined();
  });
  it("lets enrollment merge fields override everything", () => {
    expect(buildVariables({ ...person, mergeFields: { firstName: "Annie" } }, new Map()).firstName).toBe("Annie");
  });
});

describe("buildVariables aliases", () => {
  const full = {
    ...person,
    companyName: "Acme Inc",
    linkedinUrl: "https://www.linkedin.com/in/ann/",
    companyLinkedinUrl: "https://www.linkedin.com/company/acme/",
    raw: { Region: "EMEA", company: "Raw Co" },
    companyRaw: { "Company Size": "50" },
  };
  const vars = buildVariables(full, new Map([["x_job_level", "Job Level"]]));

  it("adds the alias variables", () => {
    expect(vars).toMatchObject({
      name: "Ann Lee",
      jobTitle: "CTO",
      companyName: "Acme Inc",
      linkedinUrl: "https://www.linkedin.com/in/ann/",
      linkedin: "https://www.linkedin.com/in/ann/",
      companyLinkedinUrl: "https://www.linkedin.com/company/acme/",
    });
  });
  it("exposes custom columns by camelCase name and by label", () => {
    const v = buildVariables({ ...person, custom: { x_job_level: "Senior" } }, new Map([["x_job_level", "Job Level"]]));
    expect(v.jobLevel).toBe("Senior");
    expect(v["Job Level"]).toBe("Senior");
  });
  it("keeps a custom column with no value as null so it is not mistaken for a typo", () => {
    expect(vars.jobLevel).toBeNull();
  });
  it("reaches raw keys of person and company", () => {
    expect(vars.Region).toBe("EMEA");
    expect(vars["Company Size"]).toBe("50");
    expect(vars.companySize).toBe("50");
  });
  it("renders company from the raw name when the lead has no company row", () => {
    const v = buildVariables({ ...person, companyName: null, companyDomain: null, raw: { company: "Raw Co" } }, new Map());
    expect(v.company).toBe("Raw Co");
    expect(v.companyName).toBe("Raw Co");
  });
  it("a standard field wins over a raw key and over an empty custom label", () => {
    const v = buildVariables({ ...person, raw: { Email: "raw@x.com" } }, new Map([["x_t", "Title"]]));
    expect(v.email).toBe("ann@acme.com");
    expect(v.title).toBe("CTO");
  });
  it("builds name from the parts when the full name is empty", () => {
    expect(buildVariables({ ...person, fullName: null }, new Map()).name).toBe("Ann Lee");
  });
});

describe("unresolvedTokens", () => {
  const vars = buildVariables({ ...person, phone: null }, new Map([["x_c", "Region"]]));
  it("separates empty fields from unknown ones", () => {
    const out = unresolvedTokens(["Hi {{firstName}} {{phone}} {{firstNme}}", "{{Region}} {{ region }} {{signature}}"], vars);
    expect(out).toEqual([
      { token: "phone", reason: "empty" },
      { token: "firstNme", reason: "unknown" },
      { token: "Region", reason: "empty" },
    ]);
  });
  it("looks inside spin groups", () => {
    expect(unresolvedTokens(["{Hi {{nope}}|Hello}"], vars)).toEqual([{ token: "nope", reason: "unknown" }]);
  });
  it("lists nothing when all fields fill", () => {
    expect(unresolvedTokens(["{{firstName}} at {{company}}"], vars)).toEqual([]);
  });
  it("sample lead fills the alias variables", () => {
    expect(unresolvedTokens(["{{jobTitle}} {{companyName}} {{linkedinUrl}} {{name}}"], sampleVariables())).toEqual([]);
  });
});
