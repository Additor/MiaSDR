import { describe, expect, it } from "vitest";
import { chunks } from "./chunks";

describe("chunks", () => {
  it("splits ids into full slices and puts the rest in the last one", () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const parts = chunks(ids, 200);
    expect(parts.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(parts.flat()).toEqual(ids);
  });

  it("returns no slices for no items", () => {
    expect(chunks([], 200)).toEqual([]);
  });
});
