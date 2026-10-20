import { describe, expect, it } from "vitest";
import { columnTokens, readsLookupSource, tableTokens } from "./formula-dependencies";

const call = { table: "Companies", lookupColumn: "Domain", returnColumn: "Industry" };

describe("readsLookupSource", () => {
  it("matches a table by name or id, ignoring case and spaces", () => {
    expect(readsLookupSource([call], { tableTokens: ["companies"], columnTokens: null })).toBe(true);
    expect(readsLookupSource([{ ...call, table: " COMPANIES " }], { tableTokens: ["Companies"], columnTokens: null })).toBe(true);
    expect(readsLookupSource([{ ...call, table: "11111111-1111-4111-8111-111111111111" }], { tableTokens: ["11111111-1111-4111-8111-111111111111"], columnTokens: null })).toBe(true);
  });

  it("ignores other tables", () => {
    expect(readsLookupSource([call], { tableTokens: ["People"], columnTokens: null })).toBe(false);
  });

  it("narrows to the lookup or return column when columns are named", () => {
    expect(readsLookupSource([call], { tableTokens: ["Companies"], columnTokens: ["industry"] })).toBe(true);
    expect(readsLookupSource([call], { tableTokens: ["Companies"], columnTokens: ["domain"] })).toBe(true);
    expect(readsLookupSource([call], { tableTokens: ["Companies"], columnTokens: ["Employees"] })).toBe(false);
  });

  it("reads any of several calls", () => {
    expect(readsLookupSource([call, { table: "People", lookupColumn: "Email", returnColumn: "Name" }], { tableTokens: ["People"], columnTokens: ["Name"] })).toBe(true);
    expect(readsLookupSource([], { tableTokens: ["People"], columnTokens: null })).toBe(false);
  });

  it("lists the tokens a table or column answers to", () => {
    expect(tableTokens({ id: "t1", name: "Companies" })).toEqual(["t1", "Companies"]);
    expect(columnTokens({ id: "c1", key: "industry", name: "Industry" })).toEqual(["c1", "industry", "Industry"]);
  });
});
