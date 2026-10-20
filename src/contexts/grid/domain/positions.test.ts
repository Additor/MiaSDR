import { describe, expect, it } from "vitest";
import { MIN_POSITION_GAP, placeAfter, placeBefore, type Placement } from "./keys";

type Item = { id: string; position: number };

/** Applies a placement the way the store does and returns the siblings in order. */
function apply(items: Item[], id: string, placement: Placement): Item[] {
  const moved = new Map(placement.renumber.map((m) => [m.id, m.position]));
  return [...items.map((i) => ({ id: i.id, position: moved.get(i.id) ?? i.position })), { id, position: placement.position }].sort((a, b) => a.position - b.position);
}

const strictlyIncreasing = (items: Item[]) => items.every((item, i) => i === 0 || item.position > items[i - 1].position);

describe("placeAfter and placeBefore", () => {
  it("returns the midpoint and no renumber while there is room", () => {
    const items = [{ id: "a", position: 1 }, { id: "b", position: 2 }];
    expect(placeAfter(items, "a")).toEqual({ position: 1.5, renumber: [] });
    expect(placeAfter(items)).toEqual({ position: 3, renumber: [] });
    expect(placeAfter(items, null, true)).toEqual({ position: 0.5, renumber: [] });
    expect(placeBefore(items, "b")).toEqual({ position: 1.5, renumber: [] });
    expect(placeAfter([])).toEqual({ position: 1, renumber: [] });
  });

  it("keeps every position distinct and in order across 60 inserts after one column", () => {
    let items: Item[] = [{ id: "a", position: 1 }, { id: "z", position: 2 }];
    let renumbers = 0;
    for (let n = 0; n < 60; n += 1) {
      const id = `n${n}`;
      const placement = placeAfter(items, "a");
      if (placement.renumber.length > 0) renumbers += 1;
      items = apply(items, id, placement);
      expect(strictlyIncreasing(items)).toBe(true);
      // The new column sits right after the anchor, ahead of the ones inserted earlier.
      expect(items.slice(0, 3).map((i) => i.id)).toEqual(["a", id, ...(n === 0 ? ["z"] : [`n${n - 1}`])]);
    }
    expect(renumbers).toBeGreaterThan(0);
    expect(items.map((i) => i.id)).toEqual(["a", ...Array.from({ length: 60 }, (_, i) => `n${59 - i}`), "z"]);
  });

  it("keeps the front clear after 60 inserts before the first column", () => {
    let items: Item[] = [{ id: "a", position: 1 }];
    for (let n = 0; n < 60; n += 1) {
      items = apply(items, `n${n}`, placeAfter(items, null, true));
      expect(strictlyIncreasing(items)).toBe(true);
      expect(items[0].id).toBe(`n${n}`);
      expect(items[0].position).toBeGreaterThan(0);
    }
  });

  it("repairs siblings that already share a position", () => {
    const items = [{ id: "a", position: 1 }, { id: "b", position: 1 }, { id: "c", position: 1 }];
    const next = apply(items, "x", placeAfter(items, "b"));
    expect(next.map((i) => i.id)).toEqual(["a", "b", "x", "c"]);
    expect(strictlyIncreasing(next)).toBe(true);
  });

  it("moves only the siblings whose position changes", () => {
    const items = [{ id: "a", position: 1 }, { id: "b", position: 1 + MIN_POSITION_GAP / 2 }, { id: "c", position: 5 }];
    const placement = placeAfter(items, "a");
    expect(placement.renumber.map((m) => m.id).sort()).toEqual(["b", "c"]);
    expect(placement.position).toBe(2);
  });

  it("appends after an unknown anchor", () => {
    const items = [{ id: "a", position: 1 }, { id: "b", position: 2 }];
    expect(placeAfter(items, "missing").position).toBe(3);
    expect(placeBefore(items, "missing").position).toBe(3);
  });
});
