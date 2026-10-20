import { describe, expect, it } from "vitest";
import { FALLBACK_SLUG, slugPrefix, slugify, uniqueSlug } from "./slug";

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

describe("uniqueSlug", () => {
  it("uses the plain slug when it is free", () => {
    expect(uniqueSlug("Acme Sales", ["other"])).toBe("acme-sales");
  });

  it("adds the first free numeric suffix", () => {
    expect(uniqueSlug("Acme", ["acme"])).toBe("acme-2");
    expect(uniqueSlug("Acme", ["acme", "acme-2", "acme-3"])).toBe("acme-4");
    expect(uniqueSlug("Acme", ["acme", "acme-3"])).toBe("acme-2");
  });

  it("falls back to 'organization' for a name without letters or digits", () => {
    expect(uniqueSlug("???", [])).toBe(FALLBACK_SLUG);
    expect(uniqueSlug("???", [FALLBACK_SLUG])).toBe(`${FALLBACK_SLUG}-2`);
  });

  it("keeps the suffixed slug within 48 characters", () => {
    const long = "a".repeat(60);
    const result = uniqueSlug(long, ["a".repeat(48)]);
    expect(result).toBe(`${"a".repeat(46)}-2`);
    expect(result).toHaveLength(48);
  });
});

describe("slugPrefix", () => {
  it("is shared by the plain slug and every suffixed candidate, even when the base is cut", () => {
    const base = slugify("a".repeat(60));
    const taken: string[] = [base];
    for (let n = 2; n <= 12; n += 1) {
      const next = uniqueSlug("a".repeat(60), taken);
      expect(next.startsWith(slugPrefix(base))).toBe(true);
      taken.push(next);
    }
    expect(new Set(taken).size).toBe(taken.length);
  });
});
