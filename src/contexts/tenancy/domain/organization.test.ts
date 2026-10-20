import { describe, expect, it } from "vitest";
import { ORG_NAME_MAX, organizationNameProblem } from "./organization";

describe("organizationNameProblem", () => {
  it("accepts a normal name", () => expect(organizationNameProblem("Acme Sales")).toBeNull());
  it("rejects empty and blank names", () => {
    expect(organizationNameProblem("")).not.toBeNull();
    expect(organizationNameProblem("   ")).not.toBeNull();
    expect(organizationNameProblem(undefined)).not.toBeNull();
  });
  it("caps the length after trimming", () => {
    expect(organizationNameProblem("a".repeat(ORG_NAME_MAX))).toBeNull();
    expect(organizationNameProblem(` ${"a".repeat(ORG_NAME_MAX)} `)).toBeNull();
    expect(organizationNameProblem("a".repeat(ORG_NAME_MAX + 1))).not.toBeNull();
  });
  it("rejects control characters", () => expect(organizationNameProblem("Acme\nSales")).not.toBeNull());
});
