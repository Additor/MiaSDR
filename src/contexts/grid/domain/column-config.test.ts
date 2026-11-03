import { describe, expect, it } from "vitest";
import { assertNoDependencyLoop, prepareColumnConfig, sanitizeConfig } from "./column-config";
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
  it("knows the 20 types of the table constraint", () => {
    expect(isColumnType("ai")).toBe(true);
    expect(isColumnType("bogus")).toBe(false);
    expect(effectiveColumnType({ type: "ai_output", config: { valueType: "number" } })).toBe("number");
    expect(effectiveColumnType({ type: "ai_output", config: { valueType: "ai" } })).toBe("text");
  });
});

describe("prepareColumnConfig", () => {
  it("validates select options and currency", () => {
    expect(() => prepareColumnConfig("select", { options: "x" })).toThrow(/Options/);
    expect(prepareColumnConfig("select", { options: ["x", { value: "y", label: "Y" }] }).options).toHaveLength(2);
    expect(() => prepareColumnConfig("currency", { currency: 5 })).toThrow(/Currency/);
  });
  it("limits config size and nesting", () => {
    expect(() => sanitizeConfig([])).toThrow(/object/);
    expect(() => sanitizeConfig({ big: "x".repeat(70_000) })).toThrow(/too large/);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 30; i += 1) deep = { d: deep };
    expect(() => sanitizeConfig(deep)).toThrow(/nested/);
  });
});

describe("assertNoDependencyLoop", () => {
  const columns = [
    { key: "a", name: "Summary", dependsOn: ["name"] },
    { key: "a_out", name: "Summary field", dependsOn: ["a"] },
    { key: "b", name: "Score", dependsOn: ["a_out"] },
    { key: "name", name: "Name", dependsOn: [] },
  ];

  it("refuses two columns that would read each other, through an output column too", () => {
    expect(() => assertNoDependencyLoop(columns, { key: "a", dependsOn: ["b"] })).toThrow(/Summary and Score would read each other/);
  });

  it("allows a chain and a shared input", () => {
    expect(() => assertNoDependencyLoop(columns, { key: "b", dependsOn: ["a_out", "name"] })).not.toThrow();
    expect(() => assertNoDependencyLoop(columns, { key: "a", dependsOn: ["name"] })).not.toThrow();
  });
});
