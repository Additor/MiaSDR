import { describe, expect, it } from "vitest";
import { cellResultText, cellStatus, columnRunSummary, displayValue, editorText, missingInputHint, parseEditorText, runCost, selectOptions } from "./format";
import type { GridColumn, GridRow } from "../data/types";

const col = (type: GridColumn["type"], config: Record<string, unknown> = {}): GridColumn => ({ id: "c", tableId: "t", key: "k", name: "K", type, config, dependsOn: [], position: 0, autoRun: false });

describe("format", () => {
  it("formats values by type", () => {
    expect(displayValue(1234.5, col("currency", { currency: "USD" }))).toBe("$1,234.50");
    expect(displayValue(true, col("boolean"))).toBe("Yes");
    expect(displayValue(["a", "b"], col("multiselect"))).toBe("a, b");
    expect(displayValue(null, col("text"))).toBe("");
  });
  it("prints a value as editor text, reads blank text as empty and keeps other text as typed", () => {
    expect(editorText(["a", "b"])).toBe("a, b");
    expect(editorText(42)).toBe("42");
    expect(parseEditorText("   ")).toBeNull();
    expect(parseEditorText(" x ")).toBe(" x ");
  });
  it("reads select options as strings or objects", () => {
    expect(selectOptions(col("select", { options: ["a", { value: "b", label: "Bee" }, 3] }))).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "Bee" },
    ]);
  });
  it("reads the run state of a cell", () => {
    const row = (meta: GridRow["cellMeta"]): GridRow => ({ id: "r", position: 0, cells: {}, cellMeta: meta, version: 1 });
    expect(cellStatus(row({ k: { status: "running" } }), "k").state).toBe("running");
    expect(cellStatus(row({ k: { status: "error", error: "boom" } }), "k")).toEqual({ state: "error", message: "boom" });
    expect(cellStatus(row({ k: { status: "success", outcome: "miss" } }), "k").state).toBe("miss");
    expect(cellStatus(row({}), "k").state).toBe("idle");
  });
});

describe("run cost in the cell drawer", () => {
  it("never calls a billed call free, and marks a reused answer", () => {
    expect(runCost({ costCents: 0, credits: 1 })).toBe("1 credit");
    expect(runCost({ costCents: 3, credits: 0.5 })).toBe("$0.03 · 0.5 credits");
    expect(runCost({ costCents: 0, credits: 0 })).toBe("No charge");
    expect(runCost({ costCents: 0, credits: null })).toBe("No charge");
    expect(runCost({ costCents: 0, credits: 0, reused: true })).toBe("Reused, no charge");
  });
});

describe("enrichment results in words", () => {
  const verify = { type: "enrichment", config: { actionKey: "verify-email" } };
  const statusOut = { type: "integration_output", config: { outputKey: "status", valueType: "text" } };
  const emailOut = { type: "integration_output", config: { outputKey: "email", valueType: "text" } };

  it("names verification verdicts and leaves other values alone", () => {
    expect(displayValue("catch_all", verify as never)).toBe("Catch-all");
    expect(displayValue("valid", statusOut as never)).toBe("Valid");
    expect(displayValue("catch_all", emailOut as never)).toBe("catch_all");
    expect(displayValue("Not found", verify as never)).toBe("Not found");
  });

  it("says why a cell waits, and which steps never answered a miss", () => {
    const row = (meta: Record<string, unknown>) => ({ id: "r", version: 1, cells: {}, cellMeta: { c: meta } }) as never;
    expect(cellStatus(row({ status: "queued", reason: "Hunter returned 429.", runAfter: "2026-10-21T10:00:00Z" }), "c")).toMatchObject({ state: "waiting", message: expect.stringContaining("Hunter returned 429.") });
    expect(cellStatus(row({ status: "queued" }), "c")).toEqual({ state: "running" });
    expect(cellStatus(row({ status: "success", outcome: "miss", unanswered: ["zerobounce: off"] }), "c")).toMatchObject({ state: "miss", message: expect.stringContaining("zerobounce: off") });
    expect(cellResultText({ status: "success", outcome: "hit" })).toBe("Found");
    expect(cellResultText({ status: "success", outcome: "miss" }, true)).toBe("Not settled: the first verdict a provider gave");
    expect(cellResultText({ status: "success", outcome: "miss" })).toBe("Nothing found");
    expect(cellResultText({ status: "skipped: cap" })).toBe("Held back by the auto-run limit");
  });
});

describe("what an enrichment column has left", () => {
  const find = col("enrichment", { actionKey: "find-work-email", inputs: { fullName: "name", companyDomain: "domain" } });
  const row = (cells: Record<string, unknown>, meta: GridRow["cellMeta"] = {}): GridRow => ({ id: Math.random().toString(36), cells, cellMeta: meta, version: 1 }) as GridRow;

  it("names the input an empty row needs, and nothing once it has them", () => {
    expect(missingInputHint(find, { domain: "acme.test" })).toMatchObject({ text: "Needs full name" });
    expect(missingInputHint(find, { name: "Ada", domain: "acme.test" })).toBeNull();
    expect(missingInputHint(col("text"), {})).toBeNull();
  });

  it("counts found, not found, failed and missing-input rows", () => {
    const rows = [
      row({ name: "A", domain: "a.test", k: "a@a.test" }, { k: { status: "success", outcome: "hit" } }),
      row({ name: "B", domain: "b.test" }, { k: { status: "success", outcome: "miss" } }),
      row({ name: "C", domain: "c.test" }, { k: { status: "error", error: "boom" } }),
      row({ domain: "d.test" }),
      row({ name: "E", domain: "e.test" }),
    ];
    expect(columnRunSummary(find, rows, false)).toBe("1 found · 1 not found · 1 failed · 1 need input · 1 not run");
    expect(columnRunSummary(find, rows.slice(0, 1), true)).toBe("1 found (loaded rows)");
    expect(columnRunSummary(col("text"), rows, false)).toBeNull();
  });
});
