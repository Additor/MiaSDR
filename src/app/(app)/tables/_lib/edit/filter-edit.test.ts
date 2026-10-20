import { describe, expect, it } from "vitest";
import { MAX_SORTS, MAX_VIEW_CONDITIONS, MAX_VIEW_DEPTH, validateView, type FilterCondition, type FilterGroup } from "@/contexts/grid/domain/view-query";
import {
  addCondition,
  addGroup,
  addSort,
  canAddGroup,
  countConditions,
  defaultOperatorFor,
  emptyGroup,
  groupAt,
  groupDepth,
  moveSort,
  nextSortColumn,
  nodeAt,
  normalizeFilters,
  operatorAfterColumnChange,
  operatorsFor,
  removeNode,
  removeSortAt,
  setGroupConjunction,
  setSortColumn,
  setSortDirection,
  toggleMuted,
  updateCondition,
} from "./filter-edit";

const c = (columnKey: string, value = "x", extra: Partial<FilterCondition> = {}): FilterCondition => ({ columnKey, operator: "eq", value, ...extra });
const known = new Set(["a", "b", "c", "n"]);

describe("filter tree edits", () => {
  it("adds a condition to the root and to a nested group by path", () => {
    let root = addCondition(emptyGroup(), [], c("a"));
    root = addGroup(root, [], c("b"));
    root = addCondition(root, [1], c("c"));
    expect(root.conditions).toHaveLength(2);
    expect(groupAt(root, [1])?.conditions.map((x) => (x as FilterCondition).columnKey)).toEqual(["b", "c"]);
    expect(countConditions(root)).toBe(3);
  });

  it("alternates the conjunction of a new subgroup so the nesting reads differently from its parent", () => {
    const root = addGroup(addCondition(emptyGroup(), [], c("a")), [], c("b"));
    expect((root.conditions[1] as FilterGroup).conjunction).toBe("or");
    expect(addGroup({ conjunction: "or", conditions: [c("a")] }, [], c("b")).conditions[1]).toMatchObject({ conjunction: "and" });
  });

  it("does not change the input", () => {
    const root = addCondition(emptyGroup(), [], c("a"));
    const frozen = JSON.stringify(root);
    updateCondition(root, [0], { value: "y" });
    removeNode(root, [0]);
    toggleMuted(root, [0]);
    expect(JSON.stringify(root)).toBe(frozen);
  });

  it("updates one condition and leaves siblings and groups alone", () => {
    let root = addGroup(addCondition(emptyGroup(), [], c("a")), [], c("b"));
    root = updateCondition(root, [1, 0], { operator: "contains", value: "zz" });
    expect(nodeAt(root, [1, 0])).toEqual({ columnKey: "b", operator: "contains", value: "zz" });
    expect(nodeAt(root, [0])).toEqual(c("a"));
    expect(updateCondition(root, [1], { value: "no" })).toBe(root);
    expect(updateCondition(root, [], { value: "no" })).toBe(root);
    expect(updateCondition(root, [5, 0], { value: "no" })).toBe(root);
  });

  it("mutes and unmutes a condition without storing disabled:false", () => {
    const root = addCondition(emptyGroup(), [], c("a"));
    const muted = toggleMuted(root, [0]);
    expect((muted.conditions[0] as FilterCondition).disabled).toBe(true);
    const back = toggleMuted(muted, [0]);
    expect(back.conditions[0]).toEqual(c("a"));
    expect("disabled" in (back.conditions[0] as object)).toBe(false);
  });

  it("changes the conjunction of the root and of a nested group", () => {
    let root = addGroup(addCondition(emptyGroup(), [], c("a")), [], c("b"));
    root = setGroupConjunction(root, [], "or");
    root = setGroupConjunction(root, [1], "and");
    expect(root.conjunction).toBe("or");
    expect(groupAt(root, [1])?.conjunction).toBe("and");
  });

  it("removes a node and takes an emptied subgroup with it, up the tree", () => {
    let root = addGroup(addCondition(emptyGroup(), [], c("a")), [], c("b"));
    root = addGroup(root, [1], c("c"));
    expect(groupDepth(root)).toBe(2);
    const without = removeNode(removeNode(root, [1, 0]), [1, 0]);
    expect(without.conditions).toEqual([c("a")]);
    expect(removeNode(root, [])).toBe(root);
    expect(removeNode(root, [9])).toEqual(root);
  });

  it("normalizes: prunes empty groups and returns undefined when nothing is left", () => {
    const withEmpty: FilterGroup = { conjunction: "and", conditions: [c("a"), { conjunction: "or", conditions: [] }, { conjunction: "or", conditions: [{ conjunction: "and", conditions: [] }] }] };
    expect(normalizeFilters(withEmpty)).toEqual({ conjunction: "and", conditions: [c("a")] });
    expect(normalizeFilters(emptyGroup())).toBeUndefined();
    expect(normalizeFilters(undefined)).toBeUndefined();
  });

  it("stops at the depth and condition limits that validateView enforces", () => {
    let root = addCondition(emptyGroup(), [], c("a"));
    let path: number[] = [];
    for (let depth = 1; depth <= MAX_VIEW_DEPTH; depth++) {
      expect(canAddGroup(root, path)).toBe(true);
      root = addGroup(root, path, c("b"));
      path = [...path, root === null ? 0 : (groupAt(root, path)?.conditions.length ?? 1) - 1];
    }
    expect(groupDepth(root)).toBe(MAX_VIEW_DEPTH);
    expect(canAddGroup(root, path)).toBe(false);
    expect(addGroup(root, path, c("c"))).toBe(root);
    expect(validateView({ filters: root }, known)).toBeNull();

    let wide = emptyGroup();
    for (let i = 0; i < MAX_VIEW_CONDITIONS + 5; i++) wide = addCondition(wide, [], c("a", String(i)));
    expect(countConditions(wide)).toBe(MAX_VIEW_CONDITIONS);
    expect(validateView({ filters: wide }, known)).toBeNull();
  });

  it("produces trees that validateView accepts", () => {
    let root = addCondition(emptyGroup(), [], c("a"));
    root = addGroup(root, [], c("b"));
    root = addCondition(root, [1], { columnKey: "c", operator: "empty" });
    root = toggleMuted(root, [0]);
    expect(validateView({ filters: root }, known)).toBeNull();
  });
});

describe("operators by type", () => {
  it("offers comparisons on numbers and dates, contains on text, exact matches on select and checkbox", () => {
    expect(operatorsFor("number")).toContain("gt");
    expect(operatorsFor("date")).toContain("lt");
    expect(operatorsFor("text")).toContain("contains");
    expect(operatorsFor("text")).not.toContain("gt");
    expect(operatorsFor("select")).not.toContain("contains");
    expect(operatorsFor("boolean")).toEqual(["eq", "neq", "empty", "notEmpty"]);
  });

  it("keeps the operator across a column change when the new type offers it", () => {
    expect(operatorAfterColumnChange("eq", "number")).toBe("eq");
    expect(operatorAfterColumnChange("gt", "text")).toBe(defaultOperatorFor("text"));
    expect(operatorAfterColumnChange("contains", "number")).toBe("eq");
  });
});

describe("sort edits", () => {
  const two = [{ columnKey: "a", direction: "asc" as const }, { columnKey: "b", direction: "desc" as const }];

  it("adds up to ten sorts and one per column", () => {
    let sorts = addSort([], "a");
    expect(addSort(sorts, "a")).toEqual(sorts);
    for (let i = 0; i < 20; i++) sorts = addSort(sorts, `k${i}`);
    expect(sorts).toHaveLength(MAX_SORTS);
    expect(validateView({ sorts }, new Set(sorts.map((s) => s.columnKey)))).toBeNull();
  });

  it("finds the next column that has no sort", () => {
    expect(nextSortColumn(two, ["a", "b", "c"])).toBe("c");
    expect(nextSortColumn(two, ["a", "b"])).toBeNull();
  });

  it("changes the column, refusing one another sort uses", () => {
    expect(setSortColumn(two, 0, "c")[0]).toEqual({ columnKey: "c", direction: "asc" });
    expect(setSortColumn(two, 0, "b")).toEqual(two);
    expect(setSortColumn(two, 0, "a")).toEqual(two);
  });

  it("changes direction, removes and reorders", () => {
    expect(setSortDirection(two, 0, "desc")[0].direction).toBe("desc");
    expect(removeSortAt(two, 0)).toEqual([two[1]]);
    expect(moveSort(two, 1, -1).map((s) => s.columnKey)).toEqual(["b", "a"]);
    expect(moveSort(two, 0, -1)).toEqual(two);
    expect(moveSort(two, 1, 1)).toEqual(two);
  });
});
