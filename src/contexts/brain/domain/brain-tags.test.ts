import { describe, expect, it } from "vitest";
import { MAX_TAGS, MAX_TAG_LENGTH, normalizeTags, parseTags, splitTagInput } from "./brain-tags";

describe("normalizeTags", () => {
  it("lowercases, trims, collapses spaces, drops empties and repeats", () => {
    expect(normalizeTags([" Pricing ", "PRICING", "", "  ", "On  Boarding", "faq"])).toEqual(["pricing", "on boarding", "faq"]);
  });
  it("splits a comma field", () => {
    expect(normalizeTags(splitTagInput("Pricing, onboarding,,FAQ "))).toEqual(["pricing", "onboarding", "faq"]);
  });
});

describe("parseTags", () => {
  it("accepts 50 tags of 80 characters", () => {
    const raw = Array.from({ length: MAX_TAGS }, (_, i) => `${i}`.padEnd(MAX_TAG_LENGTH, "x"));
    expect(parseTags(raw).problem).toBeNull();
  });
  it("refuses a 51st distinct tag but not a repeat of one", () => {
    const raw = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`);
    expect(parseTags(raw).problem).toMatch(/at most 50/);
    expect(parseTags([...raw.slice(0, MAX_TAGS), "T0"]).problem).toBeNull();
  });
  it("refuses a tag over 80 characters", () => {
    expect(parseTags(["x".repeat(MAX_TAG_LENGTH + 1)]).problem).toMatch(/80/);
  });
});
