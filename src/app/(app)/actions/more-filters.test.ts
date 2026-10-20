import { describe, expect, it } from "vitest";
import { hasAnyFilter, hasMoreFilters } from "./more-filters";

const none = { subcategoryId: "", campaignId: "", dueAfter: "", dueBefore: "" };
const all = { ...none, category: "", channel: "", group: "", errorsOnly: false };

describe("hasMoreFilters", () => {
  it("is false when the rare filters are empty", () => {
    expect(hasMoreFilters(none)).toBe(false);
  });

  it.each(["subcategoryId", "campaignId", "dueAfter", "dueBefore"] as const)("is true when %s is set", (key) => {
    expect(hasMoreFilters({ ...none, [key]: "x" })).toBe(true);
  });
});

describe("hasAnyFilter", () => {
  it("is false when nothing is set", () => {
    expect(hasAnyFilter(all)).toBe(false);
  });

  it("counts the common filters and the errors-only box", () => {
    expect(hasAnyFilter({ ...all, category: "interested" })).toBe(true);
    expect(hasAnyFilter({ ...all, channel: "email" })).toBe(true);
    expect(hasAnyFilter({ ...all, group: "reply" })).toBe(true);
    expect(hasAnyFilter({ ...all, errorsOnly: true })).toBe(true);
  });

  it("counts a filter inside the disclosure", () => {
    expect(hasAnyFilter({ ...all, dueAfter: "2026-01-01" })).toBe(true);
  });
});
