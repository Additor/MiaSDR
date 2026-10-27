import { describe, expect, it } from "vitest";
import { DEFAULT_REPLY_TYPES } from "./default-reply-types";

describe("default subcategories", () => {
  it("has 17 entries, each with a description (max 500) and guidance (max 2000)", () => {
    expect(DEFAULT_REPLY_TYPES).toHaveLength(17);
    for (const s of DEFAULT_REPLY_TYPES) {
      expect(s.description.trim().length, s.key).toBeGreaterThan(20);
      expect(s.description.length, s.key).toBeLessThanOrEqual(500);
      expect(s.classificationGuidance.trim().length, s.key).toBeGreaterThan(40);
      expect(s.classificationGuidance.length, s.key).toBeLessThanOrEqual(2000);
    }
  });

  it("includes the wrong_contact and already_using_a_tool subcategories", () => {
    const keys = DEFAULT_REPLY_TYPES.map((s) => s.key);
    expect(keys).toContain("wrong_contact");
    expect(keys).toContain("already_using_a_tool");
  });
});
