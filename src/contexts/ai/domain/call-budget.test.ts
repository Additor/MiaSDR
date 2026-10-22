import { describe, expect, it } from "vitest";
import { WORST_CASE_CALL_MS } from "./call-budget";

describe("model call budget", () => {
  it("ends the slowest call inside the 5-minute job lease, with a minute to settle", () => {
    expect(WORST_CASE_CALL_MS).toBeLessThanOrEqual(4 * 60_000);
  });
});
