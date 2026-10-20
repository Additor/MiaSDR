import { describe, expect, it } from "vitest";
import { mergeCompanyRaw, planCompanyMerge, type MergeSide } from "./company-merge";
import { RAW_LIMITS } from "./raw";

const side = (over: Partial<MergeSide> = {}): MergeSide => ({ name: null, linkedinUrl: null, custom: {}, raw: null, ...over });
const fields = [
  { key: "x_tier", name: "Tier" },
  { key: "x_region", name: "Region" },
];

describe("planCompanyMerge", () => {
  it("keeps the kept company's values and reports the other's as conflicts", () => {
    const plan = planCompanyMerge(side({ name: "Acme", custom: { x_tier: "Gold" } }), side({ name: "Globex", custom: { x_tier: "Silver" } }), fields);
    expect(plan.name).toBe("Acme");
    expect(plan.custom).toEqual({ x_tier: "Gold" });
    expect(plan.fieldConflicts).toEqual([
      { key: "name", name: "name", kept: "Acme", other: "Globex" },
      { key: "x_tier", name: "Tier", kept: "Gold", other: "Silver" },
    ]);
    expect(plan.filledFields).toEqual([]);
  });

  it("fills an empty or missing kept value from the other company", () => {
    const plan = planCompanyMerge(
      side({ name: null, linkedinUrl: " ", custom: { x_tier: "" } }),
      side({ name: "Globex", linkedinUrl: "https://www.linkedin.com/company/globex/", custom: { x_tier: "Silver", x_region: "EMEA" } }),
      fields,
    );
    expect(plan.name).toBe("Globex");
    expect(plan.linkedinUrl).toBe("https://www.linkedin.com/company/globex/");
    expect(plan.custom).toEqual({ x_tier: "Silver", x_region: "EMEA" });
    expect(plan.filledFields).toEqual([
      { key: "name", name: "name", value: "Globex" },
      { key: "linkedin_url", name: "LinkedIn page", value: "https://www.linkedin.com/company/globex/" },
      { key: "x_tier", name: "Tier", value: "Silver" },
      { key: "x_region", name: "Region", value: "EMEA" },
    ]);
    expect(plan.fieldConflicts).toEqual([]);
  });

  it("merges values of archived or unknown keys by the same rule, named by their key", () => {
    const plan = planCompanyMerge(side({ custom: { x_old: "kept" } }), side({ custom: { x_old: "other", x_gone: "value" } }), fields);
    expect(plan.custom).toEqual({ x_old: "kept", x_gone: "value" });
    expect(plan.fieldConflicts).toEqual([{ key: "x_old", name: "x_old", kept: "kept", other: "other" }]);
    expect(plan.filledFields).toEqual([{ key: "x_gone", name: "x_gone", value: "value" }]);
  });

  it("reports no conflict for equal values", () => {
    const plan = planCompanyMerge(side({ name: "Acme", custom: { x_tier: "Gold" } }), side({ name: "Acme", custom: { x_tier: "Gold" } }), fields);
    expect(plan.fieldConflicts).toEqual([]);
  });
});

describe("mergeCompanyRaw", () => {
  it("keeps the kept keys and reports the other's overwritten values", () => {
    const result = mergeCompanyRaw({ "Company size": "50", Industry: "Retail" }, { "Company size": "500", "Company city": "Oslo" });
    expect(result.raw).toEqual({ "Company size": "50", Industry: "Retail", "Company city": "Oslo" });
    expect(result.overwritten).toEqual({ "Company size": "500" });
    expect(result.dropped).toEqual({});
  });

  it("drops the other's keys, never the kept ones, when both do not fit under the cap", () => {
    const big = "v".repeat(1_900);
    const kept: Record<string, string> = {};
    for (let i = 0; i < 6; i += 1) kept[`kept ${i}`] = big;
    const other: Record<string, string> = { "kept 0": "other value" };
    for (let i = 0; i < 4; i += 1) other[`other ${i}`] = big;
    const result = mergeCompanyRaw(kept, other);
    for (const key of Object.keys(kept)) expect(result.raw?.[key]).toBe(big);
    const total = Object.entries(result.raw ?? {}).reduce((sum, [key, value]) => sum + key.length + value.length, 0);
    expect(total).toBeLessThanOrEqual(RAW_LIMITS.maxTotalChars);
    // The kept keys take 11,436 characters; two of the other's 1,907-character keys still fit, the last two do not.
    expect(result.dropped).toEqual({ "other 2": big, "other 3": big });
    expect(result.overwritten).toEqual({ "kept 0": "other value" });
  });

  it("answers null when neither company has raw data", () => {
    expect(mergeCompanyRaw(null, null)).toEqual({ raw: null, dropped: {}, overwritten: {} });
  });
});
