import { describe, expect, it } from "vitest";
import { buildRunBody, cellRunBody, centsCapIsInert, estimateByProvider, estimateHeadline, runCellSource, runSummary, wholeNumber, type RunForm, recalcSummary, retrySummary, stopSummary } from "./run-request";

const col = (key: string, type: string, config: Record<string, unknown> = {}) => ({ key, name: key.toUpperCase(), type, config });
const columns = [col("name", "text"), col("find", "enrichment"), col("email", "integration_output", { sourceColumnKey: "find" }), col("ask", "ai"), col("answer", "ai_output", { sourceColumnKey: "ask" }), col("orphan", "ai_output", { sourceColumnKey: "gone" }), col("bad", "ai_output", { sourceColumnKey: "name" })];

describe("runCellSource", () => {
  it("maps an output cell to the runner column that produced it", () => {
    expect(runCellSource(columns[2], columns)?.key).toBe("find");
    expect(runCellSource(columns[4], columns)?.key).toBe("ask");
  });
  it("maps a runner column to itself", () => {
    expect(runCellSource(columns[1], columns)?.key).toBe("find");
    expect(runCellSource(columns[3], columns)?.key).toBe("ask");
  });
  it("returns null for a typed cell, an output whose source is gone and an output whose source does not run", () => {
    expect(runCellSource(columns[0], columns)).toBeNull();
    expect(runCellSource(columns[5], columns)).toBeNull();
    expect(runCellSource(columns[6], columns)).toBeNull();
  });
});

describe("cellRunBody", () => {
  it("names the source column, exactly one row, replaces a filled cell, asks the providers again and limits the run to one row", () => {
    expect(cellRunBody("find", "row-1")).toEqual({ columnKey: "find", rowIds: ["row-1"], onlyEmpty: false, maxRows: 1, fresh: true });
  });
});

describe("wholeNumber", () => {
  it("accepts digits in range and rejects the rest", () => {
    expect(wholeNumber(" 25 ", 1, 100)).toBe(25);
    for (const bad of ["", "0", "101", "2.5", "-3", "1e2", "abc"]) expect(wholeNumber(bad, 1, 100)).toBeNull();
  });
});

describe("buildRunBody", () => {
  const form: RunForm = { scope: "all", selectedRowIds: [], onlyEmpty: true, maxRows: "1000", firstN: "10", maxCost: "" };

  it("sends firstN only for the first-rows scope", () => {
    expect(buildRunBody({ ...form, scope: "first", firstN: "25" })).toEqual({ body: { onlyEmpty: true, maxRows: 1000, firstN: 25 } });
    expect(buildRunBody(form)).toEqual({ body: { onlyEmpty: true, maxRows: 1000 } });
  });
  it("sends the selection only for the selected scope", () => {
    expect(buildRunBody({ ...form, scope: "selected", selectedRowIds: ["a", "b"], columnKey: "find" })).toEqual({ body: { columnKey: "find", onlyEmpty: true, maxRows: 1000, rowIds: ["a", "b"] } });
  });
  it("refuses a first-N that is not a whole number or passes the row limit, before any request", () => {
    expect(buildRunBody({ ...form, scope: "first", firstN: "0" })).toHaveProperty("error");
    expect(buildRunBody({ ...form, scope: "first", firstN: "2.5" })).toHaveProperty("error");
    expect(buildRunBody({ ...form, scope: "first", firstN: "50", maxRows: "20" })).toMatchObject({ error: expect.stringContaining("row limit of 20") });
  });
  it("refuses a bad row limit instead of silently using 1000", () => {
    expect(buildRunBody({ ...form, maxRows: "abc" })).toHaveProperty("error");
    expect(buildRunBody({ ...form, maxRows: "10001" })).toHaveProperty("error");
    expect(buildRunBody({ ...form, maxRows: "" })).toEqual({ body: { onlyEmpty: true, maxRows: 1000 } });
  });
  it("sends the cost cap when set", () => {
    expect(buildRunBody({ ...form, maxCost: "50" })).toEqual({ body: { onlyEmpty: true, maxRows: 1000, maxCostCents: 50 } });
    expect(buildRunBody({ ...form, maxCost: "-1" })).toHaveProperty("error");
  });
});

describe("toast texts", () => {
  it("count singular and plural and say when nothing failed", () => {
    expect(retrySummary(0)).toBe("No failed cells to retry.");
    expect(retrySummary(1)).toBe("Retrying 1 failed cell.");
    expect(retrySummary(1_200)).toBe("Retrying 1,200 failed cells.");
    expect(stopSummary(1)).toBe("Stopped the run. 1 queued cell was removed.");
    expect(stopSummary(0)).toBe("Stopped the run. 0 queued cells were removed.");
    expect(recalcSummary("Score x2", 1)).toBe('Recalculated "Score x2". 1 cell changed.');
  });
});

describe("run estimate", () => {
  const estimate = {
    cells: 8,
    rows: 4,
    worstCaseCostCents: 0,
    worstCaseCredits: 6,
    providers: [
      { key: "hunter", name: "Hunter", calls: 4, credits: 2, cents: 0 },
      { key: "zerobounce", name: "ZeroBounce", calls: 4, credits: 4, cents: 0 },
    ],
    dependents: [],
  };

  it("leads with rows, calls and credits, and shows dollars once a provider has a price", () => {
    expect(estimateHeadline(estimate)).toBe("4 rows · up to 8 calls · up to 6 credits");
    expect(estimateHeadline({ ...estimate, worstCaseCostCents: 8 })).toBe("4 rows · up to 8 calls · up to 6 credits · up to $0.08");
    expect(estimateByProvider(estimate)).toBe("Hunter 4 calls, 2 credits · ZeroBounce 4 calls, 4 credits");
  });

  it("says a cents cap cannot stop a run on unpriced providers", () => {
    expect(centsCapIsInert(estimate)).toBe(true);
    expect(centsCapIsInert({ ...estimate, worstCaseCostCents: 8 })).toBe(false);
  });

  it("names the credits in the toast", () => {
    expect(runSummary({ ...estimate, queued: 8 })).toBe("Queued 8 cells across 4 rows. Up to 6 credits.");
    expect(runSummary({ ...estimate, queued: 8, worstCaseCredits: 0 })).toBe("Queued 8 cells across 4 rows.");
    expect(runSummary({ ...estimate, queued: 0 })).toBe("Nothing to run. Inputs are empty or the cells are already filled.");
  });
});
