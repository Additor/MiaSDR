import { describe, expect, it } from "vitest";
import { dedupeReport, duplicateRowIds, removeColumnFromView, splitValue } from "./column-operations";
import { buildLeadImport } from "./campaign-rows";

describe("column operations", () => {
  it("splits by separator and trims", () => {
    expect(splitValue("a, b ,c", "comma")).toEqual(["a", "b", "c"]);
    expect(splitValue("a  b\tc", "space")).toEqual(["a", "b", "c"]);
    expect(splitValue("a|b", "pipe")).toEqual(["a", "b"]);
    expect(splitValue("  ", "comma")).toEqual([]);
    expect(splitValue(null, "comma")).toEqual([]);
  });

  it("keeps the first row of a duplicate and ignores blanks", () => {
    const rows = [
      { id: "1", cells: { k: "a" } },
      { id: "2", cells: { k: "a" } },
      { id: "3", cells: { k: "" } },
      { id: "4", cells: {} },
      { id: "5", cells: { k: 1 } },
      { id: "6", cells: { k: "1" } },
      { id: "7", cells: { k: "a" } },
    ];
    expect(duplicateRowIds(rows, "k")).toEqual(["2", "7"]);
  });

  it("reports the removed rows up to a cap and says when it left some out", () => {
    expect(dedupeReport(["a", "b"], 3)).toEqual({ deleted: 2, rowIds: ["a", "b"], truncated: false });
    expect(dedupeReport(["a", "b", "c", "d"], 3)).toEqual({ deleted: 4, rowIds: ["a", "b", "c"], truncated: true });
  });

  it("removes a deleted column from a saved view", () => {
    const view = removeColumnFromView(
      { hiddenColumns: ["a", "b"], sorts: [{ columnKey: "a", direction: "asc" }], filters: { conjunction: "and", conditions: [{ columnKey: "a", operator: "empty" }, { conjunction: "or", conditions: [{ columnKey: "a", operator: "empty" }, { columnKey: "b", operator: "empty" }] }] } },
      "a",
    );
    expect(view.hiddenColumns).toEqual(["b"]);
    expect(view.sorts).toEqual([]);
    expect(view.filters?.conditions).toEqual([{ conjunction: "or", conditions: [{ columnKey: "b", operator: "empty" }] }]);
  });
});

describe("buildLeadImport", () => {
  it("maps lead fields to import targets and keeps extra columns as custom fields", () => {
    const rows = [{ id: "r1", cells: { mail: "ada@x.io", first: "Ada", score: 7, tags: ["a", "b"], blank: null } }];
    const columns = [{ key: "mail", name: "Mail" }, { key: "first", name: "First" }, { key: "score", name: "Lead score" }, { key: "tags", name: "Tags" }];
    const built = buildLeadImport(rows, columns, { email: "mail", firstName: "first" }, ["score", "tags", "mail"]);
    expect(built.mapping).toEqual({ email: "email", firstName: "first_name", custom__score: "custom:Lead score", custom__tags: "custom:Tags" });
    expect(built.rows).toEqual([{ email: "ada@x.io", firstName: "Ada", custom__score: "7", custom__tags: "a, b" }]);
    expect(built.rowIds).toEqual(["r1"]);
  });
});
