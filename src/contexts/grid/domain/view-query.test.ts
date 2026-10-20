import { describe, expect, it } from "vitest";
import { MAX_VIEW_DEPTH, mergeViews, parseFilterNumber, personalOverride, sanitizePersonalView, sanitizeView, validateView, type FilterGroup, type TableView } from "./view-query";

const known = new Set(["a", "b"]);

describe("sanitizeView", () => {
  it("drops filters and sorts that name a deleted column", () => {
    const view = sanitizeView(
      {
        hiddenColumns: ["a", "gone"],
        filters: { conjunction: "or", conditions: [{ columnKey: "a", operator: "eq", value: 3 }, { columnKey: "gone", operator: "eq", value: "x" }, { columnKey: "b", operator: "bogus" }] },
        sorts: [{ columnKey: "gone", direction: "asc" }, { columnKey: "b", direction: "desc" }],
      },
      known,
    );
    expect(view).toEqual({
      hiddenColumns: ["a"],
      filters: { conjunction: "or", conditions: [{ columnKey: "a", operator: "eq", value: "3" }] },
      sorts: [{ columnKey: "b", direction: "desc" }],
    });
  });

  it("reads at most three distinct pins and drops deleted columns", () => {
    const four = new Set(["a", "b", "c", "d"]);
    expect(sanitizeView({ pinnedColumns: ["a", "a", "gone", "b", "c", "d"] }, four).pinnedColumns).toEqual(["a", "b", "c"]);
  });

  it("survives junk and cuts a view nested past the cap", () => {
    expect(sanitizeView("nope", known)).toEqual({});
    let group: unknown = { conjunction: "and", conditions: [{ columnKey: "a", operator: "empty" }] };
    for (let i = 0; i < 50; i += 1) group = { conjunction: "and", conditions: [group] };
    const view = sanitizeView({ filters: group }, known);
    let depth = 0;
    let cursor = view.filters as FilterGroup | undefined;
    while (cursor && "conditions" in (cursor.conditions[0] ?? {})) {
      cursor = cursor.conditions[0] as FilterGroup;
      depth += 1;
    }
    expect(depth).toBeLessThanOrEqual(MAX_VIEW_DEPTH);
  });
});

describe("validateView", () => {
  it("accepts a good view and names the first problem of a bad one", () => {
    expect(validateView({ sorts: [{ columnKey: "a", direction: "asc" }], filters: { conjunction: "and", conditions: [{ columnKey: "b", operator: "contains", value: "x" }] } }, known)).toBeNull();
    expect(validateView(null, known)).toMatch(/object/);
    expect(validateView({ sorts: [{ columnKey: "z", direction: "asc" }] }, known)).toMatch(/Unknown column/);
    expect(validateView({ filters: { conjunction: "and", conditions: [{ columnKey: "a", operator: "nope" }] } }, known)).toMatch(/operator/);
    expect(validateView({ filters: { conjunction: "xor", conditions: [] } }, known)).toMatch(/conjunction/);
    expect(validateView({ filters: { conjunction: "and", conditions: [{ columnKey: "a", operator: "eq", value: "x".repeat(2000) }] } }, known)).toMatch(/too long/);
  });

  it("rejects deep nesting and too many conditions", () => {
    let group: unknown = { conjunction: "and", conditions: [] };
    for (let i = 0; i < MAX_VIEW_DEPTH + 2; i += 1) group = { conjunction: "and", conditions: [group] };
    expect(validateView({ filters: group }, known)).toMatch(/nested/);
    const many = { conjunction: "and", conditions: Array.from({ length: 300 }, () => ({ columnKey: "a", operator: "empty" })) };
    expect(validateView({ filters: many }, known)).toMatch(/Too many/);
  });
});

describe("parseFilterNumber", () => {
  it("accepts the grammar the cell parser accepts", () => {
    expect(parseFilterNumber("5")).toBe(5);
    expect(parseFilterNumber("+5")).toBe(5);
    expect(parseFilterNumber("-5.25")).toBe(-5.25);
    expect(parseFilterNumber(".5")).toBe(0.5);
    expect(parseFilterNumber("1e5")).toBe(100000);
    expect(parseFilterNumber("1,234.5")).toBe(1234.5);
    expect(parseFilterNumber("$1,200")).toBe(1200);
    expect(parseFilterNumber("(1,200)")).toBe(-1200);
  });

  it("returns null for text that is not entirely a number", () => {
    for (const bad of ["abc", "12abc", "50%", "", "  ", "1e", "--5", "NaN", "Infinity"]) expect(parseFilterNumber(bad), bad).toBeNull();
  });
});

describe("validateView number filters", () => {
  const types = new Map([["n", "number"], ["c", "currency"], ["t", "text"]]);
  const view = (columnKey: string, operator: string, value?: string) => ({ filters: { conjunction: "and", conditions: [{ columnKey, operator, value }] } });
  const keys = new Set(types.keys());

  it("rejects a comparison value that is not a number", () => {
    expect(validateView(view("n", "gt", "abc"), keys, types)).toMatch(/"abc" is not a number/);
    expect(validateView(view("c", "neq", "12abc"), keys, types)).toMatch(/is not a number/);
  });

  it("accepts numbers, blank values, text columns and operators that ignore the value", () => {
    expect(validateView(view("n", "gt", "+5"), keys, types)).toBeNull();
    expect(validateView(view("n", "eq", ".5"), keys, types)).toBeNull();
    expect(validateView(view("n", "eq", ""), keys, types)).toBeNull();
    expect(validateView(view("n", "contains", "abc"), keys, types)).toBeNull();
    expect(validateView(view("n", "empty"), keys, types)).toBeNull();
    expect(validateView(view("t", "gt", "abc"), keys, types)).toBeNull();
    expect(validateView(view("n", "gt", "abc"), keys)).toBeNull();
  });
});

const contains = (columnKey: string, value: string): FilterGroup => ({ conjunction: "and", conditions: [{ columnKey, operator: "contains", value }] });
const none: FilterGroup = { conjunction: "and", conditions: [] };

describe("a member's pinned columns", () => {
  it("pass the personal view check and reach the stored override", () => {
    expect(validateView({ pinnedColumns: ["a"] }, new Set(["a", "b"]), undefined, "personal")).toBeNull();
    expect(personalOverride({ pinnedColumns: ["b"] }, { pinnedColumns: ["a"] })).toEqual({ pinnedColumns: ["a"] });
  });
});

describe("sanitizePersonalView", () => {
  const live = new Set(["a", "b"]);

  it("drops a pin list whose columns were all deleted, so the default applies again", () => {
    const mine = sanitizePersonalView({ pinnedColumns: ["gone", "also-gone"], sorts: [{ columnKey: "a", direction: "asc" }] }, live);
    expect(mine.pinnedColumns).toBeUndefined();
    expect(mergeViews({ pinnedColumns: ["b"] }, mine).pinnedColumns).toEqual(["b"]);
    expect(mine.sorts).toEqual([{ columnKey: "a", direction: "asc" }]);
  });

  it("keeps the live pins of a partly deleted list and an explicitly saved empty list", () => {
    expect(sanitizePersonalView({ pinnedColumns: ["gone", "a"] }, live).pinnedColumns).toEqual(["a"]);
    const unpinned = sanitizePersonalView({ pinnedColumns: [] }, live);
    expect(unpinned.pinnedColumns).toEqual([]);
    expect(mergeViews({ pinnedColumns: ["b"] }, unpinned).pinnedColumns).toEqual([]);
  });
});

describe("mergeViews", () => {
  const shared: TableView = { hiddenColumns: ["a"], pinnedColumns: ["b"], sorts: [{ columnKey: "a", direction: "asc" }], filters: contains("a", "x") };

  it("returns the default when the member has no override", () => {
    expect(mergeViews(shared, null)).toEqual(shared);
    expect(mergeViews(shared, {})).toEqual(shared);
  });

  it("lets each stored key win on its own", () => {
    const merged = mergeViews(shared, { filters: contains("b", "y") });
    expect(merged.filters).toEqual(contains("b", "y"));
    expect(merged.sorts).toEqual(shared.sorts);
    expect(merged.hiddenColumns).toEqual(["a"]);
  });

  it("treats an empty override as turning the default off", () => {
    const merged = mergeViews(shared, { filters: none, sorts: [], hiddenColumns: [] });
    expect(merged.filters).toEqual(none);
    expect(merged.sorts).toEqual([]);
    expect(merged.hiddenColumns).toEqual([]);
  });

  it("follows the default pins until the member stores their own", () => {
    expect(mergeViews(shared, { sorts: [] }).pinnedColumns).toEqual(["b"]);
    expect(mergeViews(shared, { pinnedColumns: ["a"] }).pinnedColumns).toEqual(["a"]);
  });

  it("lets an empty pin list unpin the default for that member", () => {
    expect(mergeViews(shared, { pinnedColumns: [] }).pinnedColumns).toEqual([]);
  });

  it("does not change its inputs", () => {
    const personal: TableView = { sorts: [] };
    mergeViews(shared, personal);
    expect(shared.sorts).toHaveLength(1);
    expect(personal).toEqual({ sorts: [] });
  });
});

describe("personalOverride", () => {
  const shared: TableView = { hiddenColumns: ["a"], sorts: [{ columnKey: "a", direction: "asc" }], filters: contains("a", "x") };

  it("stores nothing when the member sees the default", () => {
    expect(personalOverride(shared, { ...shared })).toEqual({});
    expect(personalOverride({}, { filters: none, sorts: [], hiddenColumns: [] })).toEqual({});
  });

  it("stores only the keys that differ", () => {
    expect(personalOverride(shared, { ...shared, filters: contains("b", "y") })).toEqual({ filters: contains("b", "y") });
  });

  it("stores an explicit empty value when the member removes a default", () => {
    expect(personalOverride(shared, { hiddenColumns: ["a"], sorts: shared.sorts })).toEqual({ filters: none });
    expect(personalOverride(shared, { ...shared, sorts: undefined, hiddenColumns: undefined })).toEqual({ sorts: [], hiddenColumns: [] });
  });

  it("stores a member's pins when they differ from the default", () => {
    expect(personalOverride({ ...shared, pinnedColumns: ["b"] }, { ...shared, pinnedColumns: ["a"] })).toEqual({ pinnedColumns: ["a"] });
    expect(personalOverride({ ...shared, pinnedColumns: ["b"] }, { ...shared, pinnedColumns: ["b"] })).toEqual({});
  });

  it("stores an explicit empty list when the member unpins the default", () => {
    expect(personalOverride({ ...shared, pinnedColumns: ["b"] }, { ...shared, pinnedColumns: undefined })).toEqual({ pinnedColumns: [] });
    expect(personalOverride(shared, { ...shared, pinnedColumns: [] })).toEqual({});
  });

  it("round trips pins", () => {
    const base: TableView = { ...shared, pinnedColumns: ["b"] };
    expect(mergeViews(base, personalOverride(base, { ...base, pinnedColumns: ["a", "b"] })).pinnedColumns).toEqual(["a", "b"]);
    expect(mergeViews(base, personalOverride(base, { ...base, pinnedColumns: [] })).pinnedColumns).toEqual([]);
  });

  it("round trips: merging the override over the default gives back what the member asked for", () => {
    const desired: TableView = { sorts: [], filters: contains("b", "z"), hiddenColumns: ["b"] };
    const merged = mergeViews(shared, personalOverride(shared, desired));
    expect(merged.sorts).toEqual([]);
    expect(merged.filters).toEqual(desired.filters);
    expect(merged.hiddenColumns).toEqual(["b"]);
  });
});

describe("validateView layers", () => {
  it("accepts pinned columns in both layers and rejects unknown keys in a personal view", () => {
    expect(validateView({ pinnedColumns: ["a"] }, known, undefined, "personal")).toBeNull();
    expect(validateView({ hiddenColumns: ["a"], pinnedColumns: ["b"], sorts: [], filters: none }, known, undefined, "personal")).toBeNull();
    expect(validateView({ pinnedColumns: ["a"] }, known)).toBeNull();
    expect(validateView({ name: "x" }, known, undefined, "personal")).toMatch(/default view/);
  });

  it("limits pins to three existing columns, each once", () => {
    const four = new Set(["a", "b", "c", "d"]);
    for (const layer of ["default", "personal"] as const) {
      expect(validateView({ pinnedColumns: ["a", "b", "c"] }, four, undefined, layer)).toBeNull();
      expect(validateView({ pinnedColumns: ["a", "b", "c", "d"] }, four, undefined, layer)).toMatch(/at most 3/);
      expect(validateView({ pinnedColumns: ["zz"] }, four, undefined, layer)).toMatch(/Unknown column in pinned/);
      expect(validateView({ pinnedColumns: ["a", "a"] }, four, undefined, layer)).toMatch(/once/);
      expect(validateView({ pinnedColumns: [] }, four, undefined, layer)).toBeNull();
    }
  });

  it("checks a personal view with the same column and number rules", () => {
    expect(validateView({ sorts: [{ columnKey: "z", direction: "asc" }] }, known, undefined, "personal")).toMatch(/Unknown column/);
    const bad = { conjunction: "and", conditions: [{ columnKey: "a", operator: "gt", value: "abc" }] };
    expect(validateView({ filters: bad }, known, new Map([["a", "number"]]), "personal")).toMatch(/not a number/);
  });
});
