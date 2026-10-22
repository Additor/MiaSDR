import { describe, expect, it } from "vitest";
import { CORE_TARGETS } from "@/contexts/people/domain/import-plan";
import { TARGETS, TARGET_GROUPS, mappingError } from "./mapping";

describe("import targets", () => {
  it("groups the twelve choices as Contact, Company, Custom and Skip", () => {
    expect(TARGET_GROUPS.map((g) => g.label)).toEqual(["Contact", "Company", "Custom", "Skip"]);
    expect(TARGETS).toHaveLength(12);
    expect(new Set(TARGETS.map((t) => t.value))).toEqual(new Set([...CORE_TARGETS, "custom", "skip"]));
  });

  it("uses plain names for custom and skipped columns", () => {
    const label = (value: string) => TARGETS.find((t) => t.value === value)?.label;
    expect(label("custom")).toBe("Custom field");
    expect(label("skip")).toBe("Keep in source data only");
    expect(TARGETS.map((t) => t.label).join(" ")).not.toMatch(/merge field|do not map/i);
  });
});

describe("mappingError", () => {
  const headers = ["Mail", "Name"];
  it("asks for an email or LinkedIn column", () => {
    expect(mappingError(headers, { Mail: "skip", Name: "full_name" })).toBe("Map one column to Email or LinkedIn profile.");
    expect(mappingError(headers, { Mail: "email", Name: "full_name" })).toBeNull();
  });
  it("refuses two columns for one target", () => {
    expect(mappingError(headers, { Mail: "email", Name: "email" })).toBe('More than one column is mapped to "Email".');
  });
  it("refuses an empty custom label", () => {
    expect(mappingError(headers, { Mail: "email", Name: "custom:" })).toMatch(/^Column "Name"/);
  });
});
