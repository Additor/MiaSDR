import { describe, expect, it } from "vitest";
import { coverageText, fullRunText, type EnrichmentPreview } from "./enrichment-preview";

const preview = (p: Partial<EnrichmentPreview>): EnrichmentPreview => ({ rows: 2000, ready: 1842, more: false, samples: {}, perCell: { cents: 0, credits: 1 }, ...p });

describe("enrichment preview text", () => {
  it("counts the rows that have the inputs", () => {
    expect(coverageText(preview({}))).toBe("1,842 of 2,000 rows have these inputs");
    expect(coverageText(preview({ rows: 10_000, ready: 0, more: true }))).toBe("None of the 10,000+ rows has these inputs yet.");
    expect(coverageText(preview({ rows: 0, ready: 0 }))).toBe("The table has no rows yet.");
  });

  it("prices a full run in credits, dollars or neither", () => {
    expect(fullRunText(preview({}))).toBe("A full run uses up to 1,842 credits.");
    expect(fullRunText(preview({ ready: 4, perCell: { cents: 1.5, credits: 0.5 } }))).toBe("A full run uses up to 2 credits and $0.06.");
    expect(fullRunText(preview({ perCell: { cents: 0, credits: 0 } }))).toBe("These providers have no price set.");
    expect(fullRunText(preview({ ready: 0 }))).toBeNull();
    // An upper bound rounds a fraction of a cent up.
    expect(fullRunText(preview({ ready: 1, perCell: { cents: 0.4, credits: 0 } }))).toBe("A full run uses up to $0.01.");
  });
});
