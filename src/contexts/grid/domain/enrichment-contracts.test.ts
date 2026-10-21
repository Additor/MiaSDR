import { describe, expect, it } from "vitest";
import { PROVIDER_CATALOG } from "./enrichment-catalog";
import { CONTRACTS, isSettled, percentScore, settleVerdict, verificationStatus, type ContractKey } from "./enrichment-contracts";

describe("action contracts", () => {
  it("every catalog action named after a contract offers the contract's inputs, outputs and primary", () => {
    const actions = PROVIDER_CATALOG.flatMap((entry) => entry.actions.map((action) => ({ entry: entry.key, action })));
    const contracted = actions.filter(({ action }) => action.key in CONTRACTS);
    expect(contracted.length).toBeGreaterThan(0);
    for (const { entry, action } of contracted) {
      const contract = CONTRACTS[action.key as ContractKey];
      const label = `${entry}/${action.key}`;
      expect(action.primaryOutput, label).toBe(contract.primaryOutput);
      expect(action.inputs, label).toEqual(contract.inputs);
      for (const output of contract.outputs) expect(action.outputs, label).toContainEqual(output);
      expect(new Set(action.outputs.map((o) => o.key)).size, `${label} repeats an output key`).toBe(action.outputs.length);
    }
  });

  it("maps vendor words through a table, ignoring case, and calls anything else unknown", () => {
    const table = { ok: "valid", catch_all: "catch_all" } as const;
    expect(verificationStatus(" OK ", table)).toBe("valid");
    expect(verificationStatus("catch_all", table)).toBe("catch_all");
    expect(verificationStatus("spamtrap", table)).toBe("unknown");
    expect(verificationStatus(null, table)).toBe("unknown");
  });

  it("settles valid, invalid and disposable, and moves on for catch_all and unknown", () => {
    expect(["valid", "invalid", "disposable"].every((s) => isSettled(s as never))).toBe(true);
    expect(isSettled("catch_all")).toBe(false);
    expect(isSettled("unknown")).toBe(false);
  });

  it("turns scores into integers from 0 to 100", () => {
    expect(percentScore(91)).toBe(91);
    expect(percentScore(0.876, 1)).toBe(88);
    expect(percentScore(7, 10)).toBe(70);
    expect(percentScore("55")).toBe(55);
    expect(percentScore(140)).toBe(100);
    expect(percentScore(null)).toBeNull();
    expect(percentScore("high")).toBeNull();
  });

  it("reads a verdict against a column's own settled list, and leaves other actions alone", () => {
    const catchAll = { outcome: "miss" as const, primary: "catch_all" };
    const settled = ["valid", "invalid", "disposable", "catch_all"] as const;
    expect(settleVerdict("verify-email", catchAll, [...settled]).outcome).toBe("hit");
    expect(settleVerdict("verify-email", catchAll, undefined).outcome).toBe("miss");
    // A team that asks the next verifier on "invalid" too.
    expect(settleVerdict("verify-email", { outcome: "hit" as const, primary: "invalid" }, ["valid"]).outcome).toBe("miss");
    expect(settleVerdict("find-work-email", { outcome: "miss" as const, primary: "catch_all" }, [...settled]).outcome).toBe("miss");
    expect(settleVerdict("verify-email", { outcome: "miss" as const, primary: null }, [...settled]).outcome).toBe("miss");
  });
});
