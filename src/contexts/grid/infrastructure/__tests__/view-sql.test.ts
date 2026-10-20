import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activeConditionCount, isConditionActive, type FilterCondition, type FilterGroup, type SortSpec } from "../../domain/view-query";
import { buildOrderBy, buildWhere } from "../view-sql";

const dialect = new PgDialect();
const render = (fragment: SQL | null) => (fragment ? dialect.sqlToQuery(fragment) : null);

const columns = [
  { key: "name", type: "text" },
  { key: "city", type: "text" },
  { key: "score", type: "number" },
  { key: "joined", type: "date" },
];

const eq = (columnKey: string, value: string, disabled?: boolean): FilterCondition => ({ columnKey, operator: "eq", value, ...(disabled ? { disabled } : {}) });
const group = (conjunction: "and" | "or", ...conditions: FilterGroup["conditions"]): FilterGroup => ({ conjunction, conditions });
const where = (filters: FilterGroup) => render(buildWhere({ filters }, columns));

describe("buildWhere: muted conditions", () => {
  it("leaves a muted condition out of the SQL and its value out of the parameters", () => {
    const query = where(group("and", eq("name", "ann"), eq("city", "Seoul", true)));
    expect(query?.params).toEqual(["name", "ann"]);
    expect(query?.sql).not.toContain("and");
  });

  it("returns no WHERE when every condition is muted", () => {
    expect(where(group("and", eq("name", "ann", true), eq("city", "Seoul", true)))).toBeNull();
  });

  it("keeps the other branch of an or group when one branch is muted, instead of matching nothing", () => {
    const query = where(group("or", eq("name", "ann", true), eq("city", "Seoul")));
    expect(query?.params).toEqual(["city", "Seoul"]);
    expect(query?.sql).not.toContain(" or ");
  });

  it("drops a nested group whose conditions are all muted", () => {
    const query = where(group("and", eq("name", "ann"), group("or", eq("city", "Seoul", true), eq("city", "Busan", true))));
    expect(query?.params).toEqual(["name", "ann"]);
  });

  it("treats a blank value like a muted condition", () => {
    expect(where(group("and", eq("name", "  ")))).toBeNull();
  });
});

describe("buildWhere: nested groups", () => {
  // view-filters.integration.test.ts checks which rows nested groups return; these pin the bound parameters.
  it("binds the conditions of an or group inside an and group in condition order", () => {
    expect(where(group("and", eq("name", "ann"), group("or", eq("city", "Seoul"), eq("city", "Busan"))))?.params).toEqual(["name", "ann", "city", "Seoul", "city", "Busan"]);
  });

  it("binds the conditions of groups three levels deep in condition order", () => {
    const deep = group("and", group("or", group("and", eq("name", "ann"), eq("city", "Seoul")), eq("joined", "1")));
    expect(where(deep)?.params).toEqual(["name", "ann", "city", "Seoul", "joined", "1"]);
  });

  it("combines the filter and the search with and", () => {
    const query = render(buildWhere({ filters: group("and", eq("name", "ann")), search: "x" }, columns));
    expect(query?.sql).toContain(" and ");
    expect(query?.params).toContain("%x%");
  });
});

describe("buildOrderBy", () => {
  const ten: SortSpec[] = Array.from({ length: 10 }, (_, i) => ({ columnKey: ["name", "city", "joined", "name", "city"][i % 5], direction: i % 2 === 0 ? "asc" : "desc" }));

  it("emits ten sorts in order, each with NULLS LAST, then position and id", () => {
    const query = dialect.sqlToQuery(buildOrderBy(ten, columns));
    const parts = query.sql.split(", ");
    expect(parts).toHaveLength(12);
    expect(parts.slice(0, 10).every((p) => p.endsWith("nulls last"))).toBe(true);
    expect(parts.slice(0, 10).map((p) => (p.includes(" desc ") ? "desc" : "asc"))).toEqual(ten.map((s) => s.direction));
    expect(parts[10]).toContain('"position" asc');
    expect(parts[11]).toContain('"id" asc');
    expect(query.params.filter((p) => typeof p === "string" && !p.startsWith("^"))).toEqual(ten.map((s) => s.columnKey));
  });

  it("skips a sort on a column the table no longer has", () => {
    const query = dialect.sqlToQuery(buildOrderBy([{ columnKey: "gone", direction: "asc" }], columns));
    expect(query.sql).not.toContain("nulls last");
  });
});

describe("isConditionActive agrees with the SQL builder", () => {
  const cases: Array<[string, FilterCondition]> = [
    ["plain text", { columnKey: "name", operator: "contains", value: "an" }],
    ["muted", { columnKey: "name", operator: "contains", value: "an", disabled: true }],
    ["blank value", { columnKey: "name", operator: "eq", value: "  " }],
    ["missing value", { columnKey: "name", operator: "neq" }],
    ["empty operator without value", { columnKey: "name", operator: "empty" }],
    ["notEmpty muted", { columnKey: "name", operator: "notEmpty", disabled: true }],
    ["number with a number", { columnKey: "score", operator: "gt", value: "5" }],
    ["number with text", { columnKey: "score", operator: "gt", value: "abc" }],
    ["number with a thousands comma", { columnKey: "score", operator: "lte", value: "1,200" }],
    ["number with contains", { columnKey: "score", operator: "contains", value: "abc" }],
    ["unknown column", { columnKey: "gone", operator: "eq", value: "x" }],
  ];
  const types = new Map(columns.map((col) => [col.key, col.type]));

  it.each(cases)("%s", (_name, condition) => {
    const applied = buildWhere({ filters: group("and", condition) }, columns) !== null;
    expect(activeConditionCount(group("and", condition), types) > 0).toBe(applied);
    if (condition.columnKey !== "gone") expect(isConditionActive(condition, types.get(condition.columnKey))).toBe(applied);
  });

  it("counts through nested groups", () => {
    const tree = group("and", eq("name", "a", true), group("or", eq("city", "b"), eq("city", "c", true), group("and", eq("name", "d"))));
    expect(activeConditionCount(tree, types)).toBe(2);
    expect(activeConditionCount(undefined, types)).toBe(0);
  });
});
