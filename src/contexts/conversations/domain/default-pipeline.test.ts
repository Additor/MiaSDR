import { describe, expect, it } from "vitest";
import { DEFAULT_SUBCATEGORIES } from "./default-pipeline";

describe("default subcategories", () => {
  it("has 17 entries, each with a description (max 500) and guidance (max 2000)", () => {
    expect(DEFAULT_SUBCATEGORIES).toHaveLength(17);
    for (const s of DEFAULT_SUBCATEGORIES) {
      expect(s.description.trim().length, s.key).toBeGreaterThan(20);
      expect(s.description.length, s.key).toBeLessThanOrEqual(500);
      expect(s.classificationGuidance.trim().length, s.key).toBeGreaterThan(40);
      expect(s.classificationGuidance.length, s.key).toBeLessThanOrEqual(2000);
    }
  });

  it("includes the wrong_contact and already_using_a_tool subcategories", () => {
    const keys = DEFAULT_SUBCATEGORIES.map((s) => s.key);
    expect(keys).toContain("wrong_contact");
    expect(keys).toContain("already_using_a_tool");
  });
});
