import { describe, expect, it } from "vitest";
import { planCompanyEdit } from "./company-edit";

describe("planCompanyEdit", () => {
  it("touches only the fields the form sent", () => {
    expect(planCompanyEdit({ name: "  Acme  " })).toEqual({ patch: { name: "Acme" }, customSet: {}, customRemove: [], issues: [] });
  });

  it("clears a blank name and a blank LinkedIn page", () => {
    expect(planCompanyEdit({ name: " ", linkedin: "" }).patch).toEqual({ name: null, linkedinUrl: null });
  });

  it("stores a company page in its canonical form and refuses a profile URL", () => {
    expect(planCompanyEdit({ linkedin: "linkedin.com/company/Acme?trk=1" }).patch.linkedinUrl).toBe("https://www.linkedin.com/company/acme/");
    expect(planCompanyEdit({ linkedin: "https://www.linkedin.com/in/ada" }).issues).toEqual(["LinkedIn must be a company page URL such as linkedin.com/company/name."]);
  });

  it("sets a filled company field and removes an emptied one", () => {
    const plan = planCompanyEdit({ custom: { x_tier: " Gold ", x_size: "" } });
    expect(plan.customSet).toEqual({ x_tier: "Gold" });
    expect(plan.customRemove).toEqual(["x_size"]);
  });

  it("refuses a key that is not a field key and a name over the length limit", () => {
    expect(planCompanyEdit({ custom: { "Bad Key": "1" } }).issues).toEqual(['"Bad Key" is not a custom field key.']);
    expect(planCompanyEdit({ name: "a".repeat(256) }).issues).toEqual(["Company name is longer than 255 characters."]);
  });
});
