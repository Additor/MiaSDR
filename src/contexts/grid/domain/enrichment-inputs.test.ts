import { describe, expect, it } from "vitest";
import { CONTRACTS } from "./enrichment-contracts";
import { acceptsText, inputsCovered } from "./enrichment-inputs";

const has = (...keys: string[]) => (key: string) => keys.includes(key);

describe("input combinations", () => {
  it("finds a work email from a name with a company domain or a company name", () => {
    const find = CONTRACTS["find-work-email"];
    expect(inputsCovered(find, has("fullName", "companyDomain"))).toBe(true);
    expect(inputsCovered(find, has("fullName", "companyName"))).toBe(true);
    expect(inputsCovered(find, has("fullName"))).toBe(false);
    expect(inputsCovered(find, has("companyDomain"))).toBe(false);
    expect(acceptsText(find)).toBe("Company domain, or Company name");
  });

  it("enriches a person from any one identity", () => {
    const person = CONTRACTS["enrich-person"];
    for (const keys of [["email"], ["linkedinUrl"], ["fullName", "companyDomain"], ["fullName", "companyName"]]) expect(inputsCovered(person, has(...keys))).toBe(true);
    expect(inputsCovered(person, has("fullName"))).toBe(false);
    expect(inputsCovered(person, has("companyName"))).toBe(false);
    expect(acceptsText(person)).toBe("Email, or LinkedIn URL, or Full name with Company domain, or Full name with Company name");
  });

  it("needs only the required inputs of an action that lists no combinations", () => {
    const action = { inputs: [{ key: "email", name: "Email", required: true }, { key: "note", name: "Note", required: false }] };
    expect(inputsCovered(action, has("email"))).toBe(true);
    expect(inputsCovered(action, has("note"))).toBe(false);
    expect(acceptsText(action)).toBe("Email");
  });
});
