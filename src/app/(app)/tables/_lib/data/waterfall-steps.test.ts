import { describe, expect, it } from "vitest";
import { spendSummary } from "./waterfall-steps";

describe("spend and timing summary", () => {
  it("says how the column runs, what it reuses and what caps it", () => {
    expect(spendSummary({ autoRun: false, delay: "0", reuseDays: "30" })).toBe("Manual runs · reuse 30 days");
    expect(spendSummary({ autoRun: true, delay: "2", reuseDays: "0", maxCredits: "1.5", maxCost: "", waitOnLimit: true })).toBe("Runs automatically · 2 s between calls · no reuse · up to 1.5 credits a cell · waits for rate limits");
  });
});
