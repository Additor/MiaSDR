import { describe, expect, it } from "vitest";
import { normalizePhoneCountry, phoneCountryProblem, resolvePhoneCountry } from "./phone-country";

describe("phone country", () => {
  it("accepts a known code in any case and rejects the rest", () => {
    expect(normalizePhoneCountry(" kr ")).toBe("KR");
    for (const bad of ["", "K", "KOR", "ZZ", "1A", null, 82]) expect(normalizePhoneCountry(bad)).toBeNull();
  });
  it("lets an empty value clear the setting and names the problem for a bad one", () => {
    expect(phoneCountryProblem("")).toBeNull();
    expect(phoneCountryProblem("us")).toBeNull();
    expect(phoneCountryProblem("ZZ")).toMatch(/two-letter/);
  });
  it("prefers the setting, then the environment fallback", () => {
    expect(resolvePhoneCountry("KR", "US")).toBe("KR");
    expect(resolvePhoneCountry(null, "us")).toBe("US");
    expect(resolvePhoneCountry("ZZ", "")).toBeNull();
  });
});
