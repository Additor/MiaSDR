import { describe, expect, it } from "vitest";
import { applyVerifiedGate, heldReason, verdictOf, verifyColumns } from "./verified-push";

const col = (key: string, type: string, config: Record<string, unknown>) => ({ key, name: key, type, config });

describe("verified push gate", () => {
  it("finds the enrichment and waterfall columns that verify an email, with the column they check", () => {
    const columns = [
      col("find", "enrichment", { actionKey: "find-work-email", inputs: { fullName: "name" } }),
      col("check", "enrichment", { actionKey: "verify-email", inputs: { email: "work" } }),
      col("wf", "waterfall", { steps: [{ providerKey: "a", actionKey: "verify-email" }], inputs: {} }),
      col("work", "integration_output", { sourceColumnKey: "find", outputKey: "email" }),
    ];
    expect(verifyColumns(columns)).toEqual([
      { key: "check", name: "check", emailColumnKey: "work" },
      { key: "wf", name: "wf", emailColumnKey: null },
    ]);
  });

  it("passes the allowed verdicts and holds the rest, unverified rows included", () => {
    const rows = [
      { id: "a", cells: { v: "valid" } },
      { id: "b", cells: { v: "invalid" } },
      { id: "c", cells: { v: "catch_all" } },
      { id: "d", cells: {} },
    ];
    const strict = applyVerifiedGate(rows, "v", ["valid"]);
    expect(strict.pass.map((r) => r.id)).toEqual(["a"]);
    expect(strict.held.map((h) => [h.row.id, h.verdict])).toEqual([
      ["b", "invalid"],
      ["c", "catch_all"],
      ["d", "unverified"],
    ]);
    expect(applyVerifiedGate(rows, "v", ["valid", "catch_all"]).pass.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("reads anything that is not a verdict, or a verdict from an unfinished run, as unverified", () => {
    expect(verdictOf({ id: "a", cells: { v: "Valid" } }, "v")).toBe("unverified");
    expect(verdictOf({ id: "a", cells: { v: 3 } }, "v")).toBe("unverified");
    expect(verdictOf({ id: "a", cells: { v: "valid" }, cellMeta: { v: { status: "stale" } } }, "v")).toBe("unverified");
    expect(verdictOf({ id: "a", cells: { v: "valid" }, cellMeta: { v: { status: "success" } } }, "v")).toBe("valid");
    expect(heldReason("invalid", "Verify email")).toBe("Verified Invalid by Verify email");
    expect(heldReason("unverified", "Verify email")).toBe("Not verified yet by Verify email");
    expect(heldReason("changed", "Verify email")).toBe("The email changed after Verify email checked it");
  });

  it("holds a verdict about an address the row no longer has", () => {
    const row = { id: "a", cells: { v: "valid", mail: " New@X.test " }, cellMeta: { v: { status: "success", checkedEmail: "old@x.test" } } };
    expect(verdictOf(row, "v", "mail")).toBe("changed");
    expect(verdictOf({ ...row, cells: { ...row.cells, mail: "OLD@x.test" } }, "v", "mail")).toBe("valid");
    expect(applyVerifiedGate([row], "v", ["valid"], "mail").held.map((h) => h.verdict)).toEqual(["changed"]);
  });
});
