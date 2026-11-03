import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

describe("slugify", () => {
  it("lowercases, strips accents and joins words with single dashes", () => {
    expect(slugify("  Café   Du Monde! ")).toBe("cafe-du-monde");
  });

  it("limits the length to 48 characters", () => {
    expect(slugify("a".repeat(80))).toHaveLength(48);
  });

  it("returns an empty string when nothing usable remains", () => {
    expect(slugify("日本語 !!!")).toBe("");
  });
});
