import { describe, expect, it } from "vitest";
import { planCascade, type CascadeCandidate } from "./enrichment-run-limits";

const cells = (columnKey: string, n: number, cents = 0): CascadeCandidate[] => Array.from({ length: n }, (_, i) => ({ rowId: `r${i}`, columnKey, cents }));
const limits = { maxRowsPerColumn: 100, maxCostCents: 500, room: 2000 };

describe("planCascade", () => {
  it("lets everything through under the caps", () => {
    const plan = planCascade(cells("a", 10), limits);
    expect(plan.allowed).toHaveLength(10);
    expect(plan.skipped).toHaveLength(0);
  });

  it("caps rows per column, not per event", () => {
    const plan = planCascade([...cells("a", 1000), ...cells("b", 1000)], limits);
    expect(plan.allowed.filter((c) => c.columnKey === "a")).toHaveLength(100);
    expect(plan.allowed.filter((c) => c.columnKey === "b")).toHaveLength(100);
    expect(plan.skipped).toHaveLength(1800);
  });

  it("stops at the worst-case cost cap", () => {
    const plan = planCascade(cells("a", 100, 30), limits);
    expect(plan.allowed).toHaveLength(16);
    expect(plan.allowed.length * 30).toBeLessThanOrEqual(500);
  });

  it("stops at the room left in the organization's queue", () => {
    const plan = planCascade([...cells("a", 100), ...cells("b", 100)], { ...limits, room: 120 });
    expect(plan.allowed).toHaveLength(120);
    expect(planCascade(cells("a", 5), { ...limits, room: 0 }).allowed).toHaveLength(0);
  });
});
