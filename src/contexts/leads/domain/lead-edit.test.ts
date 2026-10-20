import { describe, expect, it } from "vitest";
import { NEW_PERSON, planLeadEdit, type LeadCurrent } from "./lead-edit";

const current: LeadCurrent = { email: "ada@acme.com", linkedinSlug: null, firstName: "Ada", lastName: "Kim", fullName: "Ada Kim", companyDomain: "acme.com" };

describe("planLeadEdit", () => {
  it("normalizes email, LinkedIn, phone and domain like an import", () => {
    const plan = planLeadEdit(current, {
      email: " ADA@Acme.COM ",
      linkedin: "https://www.linkedin.com/in/Ada-Kim/?x=1",
      phone: "010-1234-5678",
      companyDomain: "https://www.Beta.io/about",
      defaultCountry: "KR",
    });
    expect(plan.issues).toEqual([]);
    expect(plan.patch).toMatchObject({ email: "ada@acme.com", linkedinSlug: "ada-kim", phone: "+821012345678" });
    expect(plan.company).toEqual({ domain: "beta.io", name: null });
  });

  it("writes the canonical URL with the slug, and clears both together", () => {
    expect(planLeadEdit(current, { linkedin: "linkedin.com/in/Ada-Kim" }).patch).toMatchObject({
      linkedinSlug: "ada-kim",
      linkedinUrl: "https://www.linkedin.com/in/ada-kim/",
    });
    expect(planLeadEdit(current, { linkedin: "" }).patch).toMatchObject({ linkedinSlug: null, linkedinUrl: null });
  });

  it("stores a company page as the URL without a slug", () => {
    const plan = planLeadEdit(current, { linkedin: "https://www.linkedin.com/company/acme/" });
    expect(plan.issues).toEqual([]);
    expect(plan.patch).toMatchObject({ linkedinSlug: null, linkedinUrl: "https://www.linkedin.com/company/acme/" });
  });

  it("reports unreadable values with a message", () => {
    const plan = planLeadEdit(current, { email: "nope", phone: "12", linkedin: "https://example.com/x", companyDomain: "a b" });
    expect(plan.issues).toHaveLength(4);
  });

  it("keeps the lead identifiable", () => {
    expect(planLeadEdit(current, { email: "" }).issues).toContain("A lead needs an email or a LinkedIn profile.");
    expect(planLeadEdit(current, { email: "", linkedin: "linkedin.com/in/ada" }).issues).toEqual([]);
  });

  it("derives the full name from the parts when it is blank", () => {
    const plan = planLeadEdit(current, { firstName: "Adeline", fullName: "" });
    expect(plan.patch).toMatchObject({ firstName: "Adeline", fullName: "Adeline Kim" });
  });

  it("detaches the company on an empty domain and leaves it alone when untouched", () => {
    expect(planLeadEdit(current, { companyDomain: "" }).company).toBeNull();
    expect(planLeadEdit(current, { title: "CTO" }).company).toBeUndefined();
  });

  it("clears a field with an empty string", () => {
    expect(planLeadEdit(current, { title: "", phone: "" }).patch).toMatchObject({ title: null, phone: null });
  });

  it("sets, removes and adds custom fields", () => {
    const plan = planLeadEdit(current, { custom: { x_size: "50", x_old: "" }, newCustom: [{ label: "회사 규모", value: "큼" }, { label: "", value: "" }] });
    expect(plan.customSet.x_size).toBe("50");
    expect(plan.customRemove).toEqual(["x_old"]);
    expect(plan.newColumns).toHaveLength(1);
    expect(plan.newColumns[0].name).toBe("회사 규모");
    expect(plan.newColumns[0].value).toBe("큼");
  });

  it("keeps new-label values apart from custom keys and merges labels that fold to one name", () => {
    const plan = planLeadEdit(current, { custom: { x_plan: "Pro" }, newCustom: [{ label: "Plan", value: "" }, { label: "plan", value: "Team" }, { label: "Plan!", value: "Solo" }] });
    expect(plan.customSet).toEqual({ x_plan: "Pro" });
    expect(plan.newColumns).toEqual([{ name: "Plan", value: "Team" }, { name: "Plan!", value: "Solo" }]);
    expect(plan.issues).toEqual([]);
    const clash = planLeadEdit(current, { newCustom: [{ label: "Plan", value: "A" }, { label: "plan", value: "B" }] });
    expect(clash.issues).toEqual(['"plan" is listed twice with different values.']);
  });

  it("rejects overlong values and bad custom keys", () => {
    expect(planLeadEdit(current, { title: "x".repeat(300) }).issues).toHaveLength(1);
    expect(planLeadEdit(current, { custom: JSON.parse('{"__proto__":"x"}') }).issues).toHaveLength(1);
  });

  it("refuses a webmail domain the lead does not have yet, and keeps one it has", () => {
    expect(planLeadEdit(current, { companyDomain: "gmail.com" }).issues).toEqual(["gmail.com is an email provider, not a company domain."]);
    const stored = { ...current, companyDomain: "gmail.com" };
    const plan = planLeadEdit(stored, { companyDomain: "gmail.com", title: "CTO" });
    expect(plan.issues).toEqual([]);
    expect(plan.company).toEqual({ domain: "gmail.com", name: null });
  });

  it("passes the typed company name with the domain", () => {
    expect(planLeadEdit(current, { companyDomain: "www.globex.com", companyName: " Globex " }).company).toEqual({ domain: "globex.com", name: "Globex" });
  });
});

describe("planLeadEdit in create mode", () => {
  it("plans a new contact from an empty person", () => {
    const plan = planLeadEdit(NEW_PERSON, { firstName: "Ada", lastName: "Kim", email: "ADA@acme.com", companyDomain: "acme.com" }, { mode: "create" });
    expect(plan.issues).toEqual([]);
    expect(plan.patch).toMatchObject({ firstName: "Ada", lastName: "Kim", fullName: "Ada Kim", email: "ada@acme.com" });
    expect(plan.company).toEqual({ domain: "acme.com", name: null });
  });

  it("says contact in the identity message", () => {
    expect(planLeadEdit(NEW_PERSON, { firstName: "Ada" }, { mode: "create" }).issues).toEqual(["A contact needs an email or a LinkedIn profile."]);
    expect(planLeadEdit(NEW_PERSON, { linkedin: "linkedin.com/in/ada" }, { mode: "create" }).issues).toEqual([]);
  });

  it("refuses a webmail domain and an unreadable one", () => {
    expect(planLeadEdit(NEW_PERSON, { email: "a@b.co", companyDomain: "naver.com" }, { mode: "create" }).issues).toEqual(["naver.com is an email provider, not a company domain."]);
    expect(planLeadEdit(NEW_PERSON, { email: "a@b.co", companyDomain: "a b" }, { mode: "create" }).issues).toEqual(['"a b" is not a company domain or website.']);
  });

  it("asks for a domain before a company name", () => {
    expect(planLeadEdit(NEW_PERSON, { email: "a@b.co", companyName: "Acme" }, { mode: "create" }).issues).toEqual(["Add the company domain to name a new company."]);
  });
});
