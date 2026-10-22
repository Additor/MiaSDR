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

  it("reads anything that is not a verdict as unverified, and words the skip", () => {
    expect(verdictOf("Valid")).toBe("unverified");
    expect(verdictOf(3)).toBe("unverified");
    expect(heldReason("invalid", "Verify email")).toBe("Verified Invalid by Verify email");
    expect(heldReason("unverified", "Verify email")).toBe("Not verified yet by Verify email");
  });
});
