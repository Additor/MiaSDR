import { describe, expect, it } from "vitest";
import { archiveBlocker, cleanColumnName, deleteBlocker, findDuplicate, isCompleteOrder, newColumnKey, renameBlocker } from "./custom-columns";

const col = (id: string, name: string, extra: Partial<{ key: string; isCore: boolean; archivedAt: Date | null }> = {}) => ({
  id,
  key: extra.key ?? "x_" + name.toLowerCase(),
  name,
  isCore: extra.isCore ?? false,
  archivedAt: extra.archivedAt ?? null,
});

describe("cleanColumnName", () => {
  it("trims and collapses whitespace", () => {
    expect(cleanColumnName("  Plan   tier ")).toEqual({ ok: true, name: "Plan tier" });
  });
  it("refuses empty, over-long and symbol-only names", () => {
    expect(cleanColumnName("   ").ok).toBe(false);
    expect(cleanColumnName("a".repeat(61)).ok).toBe(false);
    expect(cleanColumnName("a".repeat(60)).ok).toBe(true);
    expect(cleanColumnName("!!!").ok).toBe(false);
  });
  it("accepts Korean labels", () => {
    expect(cleanColumnName("회사 규모").ok).toBe(true);
  });
});

describe("findDuplicate", () => {
  const all = [col("1", "Plan"), col("2", "Region", { archivedAt: new Date() })];
  it("matches ignoring case and spacing, archived included", () => {
    expect(findDuplicate("  PLAN ", all)?.id).toBe("1");
    expect(findDuplicate("region", all)?.id).toBe("2");
  });
  it("ignores the column being renamed", () => {
    expect(findDuplicate("plan", all, "1")).toBeUndefined();
  });
  it("does not match different names", () => {
    expect(findDuplicate("Plans", all)).toBeUndefined();
  });
});

describe("newColumnKey", () => {
  it("uses the import derivation", () => {
    expect(newColumnKey("Job Title", [])).toBe("x_job_title");
  });
  it("suffixes a collision of punctuation-only variants", () => {
    expect(newColumnKey("Plan!", ["x_plan"])).toBe("x_plan_2");
    expect(newColumnKey("Plan?", ["x_plan", "x_plan_2"])).toBe("x_plan_3");
  });
  it("returns null for a label without letters or digits", () => {
    expect(newColumnKey("---", [])).toBeNull();
  });
  it("produces keys the table check accepts", () => {
    for (const name of ["회사 규모", "1st touch", "Plan!"]) expect(newColumnKey(name, ["x_plan"])).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe("lifecycle rules", () => {
  it("allows delete only for an archived custom column", () => {
    expect(deleteBlocker(col("1", "A"))).toMatch(/Archive the field first/);
    expect(deleteBlocker(col("1", "A", { archivedAt: new Date() }))).toBeNull();
    expect(deleteBlocker(col("1", "A", { isCore: true, archivedAt: new Date() }))).toMatch(/Built-in/);
  });
  it("refuses to archive twice or a core column", () => {
    expect(archiveBlocker(col("1", "A"))).toBeNull();
    expect(archiveBlocker(col("1", "A", { archivedAt: new Date() }))).toMatch(/already/);
    expect(archiveBlocker(col("1", "A", { isCore: true }))).toMatch(/Built-in/);
  });
  it("refuses to rename a core column", () => {
    expect(renameBlocker({ isCore: true })).not.toBeNull();
    expect(renameBlocker({ isCore: false })).toBeNull();
  });
});

describe("isCompleteOrder", () => {
  const active = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("accepts any permutation of the active set", () => {
    expect(isCompleteOrder(["c", "a", "b"], active)).toBe(true);
  });
  it("refuses missing, extra and repeated ids", () => {
    expect(isCompleteOrder(["a", "b"], active)).toBe(false);
    expect(isCompleteOrder(["a", "b", "c", "d"], active)).toBe(false);
    expect(isCompleteOrder(["a", "a", "b"], active)).toBe(false);
    expect(isCompleteOrder(["a", "b", "x"], active)).toBe(false);
  });
});
