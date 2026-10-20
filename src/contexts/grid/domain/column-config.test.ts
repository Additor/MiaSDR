import { describe, expect, it } from "vitest";
import { assertNoCycle, configDependencies, prepareColumnConfig, sanitizeConfig, topologicalOrder } from "./column-config";
import { effectiveColumnType, isColumnType } from "./column-types";
import { positionAfter, positionBefore, toColumnKey, uniqueColumnKey, uniqueColumnName } from "./keys";

describe("column keys and names", () => {
  it("builds readable camelCase keys", () => {
    expect(toColumnKey("Job Title")).toBe("jobTitle");
    expect(toColumnKey("Email (work)")).toBe("emailWork");
    expect(toColumnKey("2nd contact")).toBe("c2ndContact");
    expect(toColumnKey("이름")).toBe("이름");
  });
  it("keeps keys and names unique", () => {
    expect(uniqueColumnKey("Name", new Set(["name", "name2"]))).toBe("name3");
    expect(uniqueColumnKey("이름", new Set())).toBe("이름");
    expect(uniqueColumnKey("🔥", new Set())).toBe("column");
    expect(uniqueColumnName("Text", ["text", "Text 2"])).toBe("Text 3");
  });
  it("places columns between neighbours without renumbering", () => {
    const cols = [{ id: "a", position: 1 }, { id: "b", position: 2 }];
    expect(positionAfter(cols, "a")).toBe(1.5);
    expect(positionAfter(cols, "b")).toBe(3);
    expect(positionAfter(cols)).toBe(3);
    expect(positionAfter(cols, null, true)).toBe(0.5);
    expect(positionBefore(cols, "b")).toBe(1.5);
    expect(positionBefore(cols, "a")).toBe(0.5);
  });
});

describe("column types", () => {
  it("knows the 21 types of the table constraint", () => {
    expect(isColumnType("formula")).toBe(true);
    expect(isColumnType("bogus")).toBe(false);
    expect(effectiveColumnType({ type: "ai_output", config: { valueType: "number" } })).toBe("number");
    expect(effectiveColumnType({ type: "ai_output", config: { valueType: "formula" } })).toBe("text");
  });
});

describe("prepareColumnConfig", () => {
  const keys = new Set(["a", "b"]);
  it("validates select options and currency", () => {
    expect(() => prepareColumnConfig("select", { options: "x" }, keys, "c")).toThrow(/Options/);
    expect(prepareColumnConfig("select", { options: ["x", { value: "y", label: "Y" }] }, keys, "c").config.options).toHaveLength(2);
    expect(() => prepareColumnConfig("currency", { currency: 5 }, keys, "c")).toThrow(/Currency/);
  });
  it("parses formulas and finds their dependencies", () => {
    expect(prepareColumnConfig("formula", { expression: "{{a}} + {{b}}" }, keys, "c").dependsOn.sort()).toEqual(["a", "b"]);
    expect(() => prepareColumnConfig("formula", { expression: "{{zzz}}" }, keys, "c")).toThrow(/unknown column/);
    expect(() => prepareColumnConfig("formula", { expression: "{{c}}" }, keys, "c")).toThrow(/unknown column/);
    expect(() => prepareColumnConfig("formula", { expression: "1 +" }, keys, "c")).toThrow();
    expect(() => prepareColumnConfig("formula", {}, keys, "c")).toThrow(/required/);
  });
  it("reads dependencies of runner configs from tokens and column properties", () => {
    const deps = configDependencies({ url: "https://x/{{a}}", inputs: { q: { source: "column", columnKey: "b" } }, nested: [{ t: "{{ c }}" }] });
    expect(deps.sort()).toEqual(["a", "b", "c"]);
  });
  it("limits config size and nesting", () => {
    expect(() => sanitizeConfig([])).toThrow(/object/);
    expect(() => sanitizeConfig({ big: "x".repeat(70_000) })).toThrow(/too large/);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 30; i += 1) deep = { d: deep };
    expect(() => sanitizeConfig(deep)).toThrow(/nested/);
  });
});

describe("dependency graph", () => {
  it("rejects a cycle and orders the rest", () => {
    const cols = [{ key: "a", dependsOn: [] as string[] }, { key: "b", dependsOn: ["a"] }];
    expect(() => assertNoCycle(cols, { key: "a", dependsOn: ["b"] })).toThrow(/Circular/);
    expect(() => assertNoCycle(cols, { key: "c", dependsOn: ["b"] })).not.toThrow();
    expect(topologicalOrder([{ key: "b", dependsOn: ["a"] }, { key: "a", dependsOn: [] }, { key: "z", dependsOn: ["gone"] }]).map((c) => c.key)).toEqual(["a", "b", "z"]);
  });
});
