import { describe, expect, it } from "vitest";
import { buildImportRecords, inferColumnType, isInitialSeedColumn, normalizeMapping, planImportColumns, suggestMapping } from "./import-plan";

describe("inferColumnType", () => {
  it.each([
    [["a@x.io", "b@y.io"], "email"],
    [["https://a.io", "http://b.io"], "url"],
    [["0", "1", "1"], "number"],
    [["yes", "no"], "boolean"],
    [["1", "2", "3.5", "N/A", "4", "5", "6", "7", "8", "9", "10"], "number"],
    [["2024-01-05", "2024-02-06"], "date"],
    [["02134", "10001"], "text"],
    [["Ada", "Grace"], "text"],
    [[], "text"],
  ])("%j is %s", (samples, expected) => expect(inferColumnType(samples as string[])).toBe(expected));
});

describe("mapping", () => {
  const existing = [
    { key: "name", name: "Name", type: "text" },
    { key: "email", name: "Email", type: "email" },
  ];

  it("suggests existing columns, once each, and creates the rest", () => {
    const mapping = suggestMapping(["Name", "name", "E-mail", "Email", "Age", ""], [["Ada", "x", "", "a@x.io", "30", ""]], existing);
    expect(mapping[0]).toEqual({ headerIndex: 0, action: "map", columnKey: "name" });
    expect(mapping[1].action).toBe("create");
    expect(mapping[2]).toEqual({ headerIndex: 2, action: "map", columnKey: "email" });
    expect(mapping[3].action).toBe("create");
    expect(mapping[4]).toMatchObject({ action: "create", type: "number" });
    expect(mapping[5]).toEqual({ headerIndex: 5, action: "skip" });
  });

  it("validates a client mapping", () => {
    const keys = new Set(["name", "email"]);
    const headers = ["A", "B", "C"];
    expect(() => normalizeMapping("x", headers, keys)).toThrow(/array/);
    expect(() => normalizeMapping([{ headerIndex: 5, action: "skip" }], headers, keys)).toThrow(/headerIndex/);
    expect(() => normalizeMapping([{ headerIndex: 0, action: "skip" }, { headerIndex: 0, action: "skip" }], headers, keys)).toThrow(/more than once/);
    expect(() => normalizeMapping([{ headerIndex: 0, action: "map", columnKey: "nope" }], headers, keys)).toThrow(/unknown column/);
    expect(() => normalizeMapping([{ headerIndex: 0, action: "map", columnKey: "name" }, { headerIndex: 1, action: "map", columnKey: "name" }], headers, keys)).toThrow(/more than one/);
    expect(() => normalizeMapping([{ headerIndex: 0, action: "create", type: "enrichment" }], headers, keys)).toThrow(/not a column type/);
    expect(() => normalizeMapping([{ headerIndex: 0, action: "create", type: "text", name: "x".repeat(300) }], headers, keys)).toThrow(/characters or fewer/);
    expect(() => normalizeMapping(Array.from({ length: 4 }, (_, i) => ({ headerIndex: i, action: "skip" })), headers, keys)).toThrow(/more entries/);
    expect(normalizeMapping([{ headerIndex: 1, action: "create", type: "text" }], headers, keys)).toEqual([{ headerIndex: 1, action: "create", name: "B", type: "text" }]);
  });
});

describe("suggestMapping on a fresh table", () => {
  it("does not match the starter column by accident", () => {
    const mapping = suggestMapping(["Name", "Age"], [["Ada", "30"]], [{ key: "name", name: "New Column" }]);
    expect(mapping.map((m) => m.action)).toEqual(["create", "create"]);
  });
});

describe("planImportColumns and records", () => {
  it("reuses the seed column for the first new column and keeps keys unique", () => {
    const existing = [{ key: "name", name: "New Column", type: "text" }];
    expect(isInitialSeedColumn(existing)).toBe(true);
    const plan = planImportColumns(
      [
        { headerIndex: 0, action: "create", name: "Company", type: "text" },
        { headerIndex: 1, action: "create", name: "Company", type: "number" },
        { headerIndex: 2, action: "skip" },
      ],
      existing,
      { canReuseSeedColumn: true },
    );
    expect(plan.newColumns).toEqual([
      { key: "company", name: "Company", type: "text", reuseExisting: true, replacesKey: "name" },
      { key: "company2", name: "Company 2", type: "number", reuseExisting: false },
    ]);
    const records = buildImportRecords([["Acme", "1,200", "x"], ["", "", "y"], ["Beta", "N/A", ""]], plan);
    expect(records).toEqual([{ company: "Acme", company2: 1200 }, { company: "Beta", company2: "N/A" }]);
  });

  it("does not reuse the seed when the file maps onto it", () => {
    const existing = [{ key: "name", name: "New Column", type: "text" }];
    const plan = planImportColumns([{ headerIndex: 0, action: "map", columnKey: "name" }, { headerIndex: 1, action: "create", name: "Age", type: "number" }], existing, { canReuseSeedColumn: true });
    expect(plan.newColumns).toEqual([{ key: "age", name: "Age", type: "number", reuseExisting: false }]);
  });

  it("does not rename the seed when another column exists, even if the caller allows reuse", () => {
    const existing = [
      { key: "name", name: "New Column", type: "text" },
      { key: "f", name: "F", type: "formula", config: { expression: "UPPER({{name}})" }, dependsOn: ["name"] },
    ];
    expect(isInitialSeedColumn(existing)).toBe(false);
    const plan = planImportColumns([{ headerIndex: 0, action: "create", name: "Company", type: "text" }], existing, { canReuseSeedColumn: true });
    expect(plan.newColumns).toEqual([{ key: "company", name: "Company", type: "text", reuseExisting: false }]);
  });

  it("does not reuse a lone seed column that carries config or dependencies", () => {
    for (const extra of [{ config: { expression: "1" } }, { dependsOn: ["x"] }]) {
      const existing = [{ key: "name", name: "New Column", type: "formula", ...extra }];
      expect(isInitialSeedColumn(existing)).toBe(false);
      const plan = planImportColumns([{ headerIndex: 0, action: "create", name: "Company", type: "text" }], existing, { canReuseSeedColumn: true });
      expect(plan.newColumns[0].reuseExisting).toBe(false);
    }
  });

  it("restores an apostrophe that csv export added and truncates oversized cells", () => {
    const plan = planImportColumns([{ headerIndex: 0, action: "create", name: "A", type: "text" }], [], { canReuseSeedColumn: false });
    const records = buildImportRecords([["'=1+1"], ["x".repeat(50_000)], ["a\u0000b"]], plan);
    expect(records[0]).toEqual({ a: "=1+1" });
    expect((records[1].a as string).length).toBe(20_000);
    expect(records[2]).toEqual({ a: "ab" });
  });
});
