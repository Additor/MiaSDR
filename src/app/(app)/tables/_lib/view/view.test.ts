import { describe, expect, it } from "vitest";
import { addFilter, filtersNarrow, keepsTableOrder, removeFilter, setSort, toggleHidden } from "./view";

describe("view helpers", () => {
  it("adds and removes filters", () => {
    const one = addFilter({}, { columnKey: "a", operator: "contains", value: "x" });
    const two = addFilter(one, { columnKey: "b", operator: "empty" });
    expect(two.filters?.conditions).toHaveLength(2);
    expect(removeFilter(two, 0).filters?.conditions).toEqual([{ columnKey: "b", operator: "empty" }]);
    expect(removeFilter(removeFilter(two, 0), 0).filters).toBeUndefined();
  });
  it("keeps one sort per column and can replace all of them", () => {
    const view = setSort({ sorts: [{ columnKey: "a", direction: "asc" }] }, "b", "desc");
    expect(view.sorts).toEqual([{ columnKey: "a", direction: "asc" }, { columnKey: "b", direction: "desc" }]);
    expect(setSort(view, "a", "desc").sorts?.map((s) => s.columnKey)).toEqual(["b", "a"]);
    expect(setSort(view, "c", "asc", { only: true }).sorts).toEqual([{ columnKey: "c", direction: "asc" }]);
    expect(setSort(view, "a", null).sorts).toEqual([{ columnKey: "b", direction: "desc" }]);
  });
  it("hides and shows columns", () => {
    expect(toggleHidden({}, "a", true).hiddenColumns).toEqual(["a"]);
    expect(toggleHidden({ hiddenColumns: ["a"] }, "a", false).hiddenColumns).toEqual([]);
  });
  it("only appends new rows when the loaded rows are the table in order", () => {
    expect(keepsTableOrder({}, "")).toBe(true);
    expect(keepsTableOrder({}, "acme")).toBe(false);
    expect(keepsTableOrder({ sorts: [{ columnKey: "a", direction: "asc" }] }, "")).toBe(false);
  });
  it("counts only active conditions when it decides if rows append in place", () => {
    const muted = { filters: { conjunction: "and" as const, conditions: [{ columnKey: "a", operator: "eq" as const, value: "x", disabled: true }] } };
    expect(keepsTableOrder(muted, "")).toBe(true);
    const blank = { filters: { conjunction: "and" as const, conditions: [{ columnKey: "a", operator: "eq" as const, value: "" }] } };
    expect(keepsTableOrder(blank, "")).toBe(true);
    const mixed = { filters: { conjunction: "and" as const, conditions: [muted.filters.conditions[0], { columnKey: "b", operator: "empty" as const }] } };
    expect(keepsTableOrder(mixed, "")).toBe(false);
    const nestedMuted = { filters: { conjunction: "or" as const, conditions: [{ conjunction: "and" as const, conditions: [muted.filters.conditions[0]] }] } };
    expect(keepsTableOrder(nestedMuted, "")).toBe(true);
    const nestedActive = { filters: { conjunction: "or" as const, conditions: [{ conjunction: "and" as const, conditions: [{ columnKey: "a", operator: "contains" as const, value: "y" }] }] } };
    expect(keepsTableOrder(nestedActive, "")).toBe(false);
  });
  it("reads a number filter with text as inactive when the column types are known", () => {
    const view = { filters: { conjunction: "and" as const, conditions: [{ columnKey: "n", operator: "gt" as const, value: "abc" }] } };
    const types = new Map([["n", "number"]]);
    expect(keepsTableOrder(view, "", types)).toBe(true);
    expect(filtersNarrow(view, types)).toBe(false);
    expect(filtersNarrow({ filters: { conjunction: "and", conditions: [{ columnKey: "n", operator: "gt", value: "5" }] } }, types)).toBe(true);
    // A condition on a column the table lost applies nothing.
    expect(filtersNarrow({ filters: { conjunction: "and", conditions: [{ columnKey: "gone", operator: "empty" }] } }, types)).toBe(false);
  });
});
