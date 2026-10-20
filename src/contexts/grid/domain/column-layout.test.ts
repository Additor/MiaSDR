import { describe, expect, it } from "vitest";
import { chainPlacement } from "./column-layout";

const cols = (...positions: number[]) => positions.map((position, i) => ({ id: `c${i}`, position }));

describe("chainPlacement", () => {
  it("puts the chain after the anchor, in order, between the anchor and its neighbour", () => {
    const { positions, renumber } = chainPlacement(cols(1, 2, 3), 3, "c0");
    expect(renumber).toEqual([]);
    expect(positions[0]).toBeGreaterThan(1);
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
    expect(positions[2]).toBeLessThan(2);
  });

  it("appends at the end without an anchor", () => {
    expect(chainPlacement(cols(1, 2), 2).positions).toEqual([3, 4]);
    expect(chainPlacement([], 2).positions).toEqual([1, 2]);
  });

  it("renumbers the siblings when the gap has run out and keeps the whole order strict", () => {
    const tight = [{ id: "a", position: 1 }, { id: "b", position: 1 + 1e-9 }, { id: "c", position: 2 }];
    const { positions, renumber } = chainPlacement(tight, 3, "a");
    expect(renumber.length).toBeGreaterThan(0);
    const after = new Map(tight.map((c) => [c.id, c.position]));
    for (const move of renumber) after.set(move.id, move.position);
    const all = [...after.entries(), ...positions.map((p, i) => [`new-${i}`, p] as const)].sort((x, y) => x[1] - y[1]);
    expect(all.map(([id]) => id)).toEqual(["a", "new-0", "new-1", "new-2", "b", "c"]);
    expect(new Set(all.map(([, p]) => p)).size).toBe(all.length);
  });

  it("never reports a move for a new column", () => {
    const { renumber } = chainPlacement([{ id: "a", position: 1 }, { id: "b", position: 1 + 1e-9 }], 4, "a");
    expect(renumber.every((m) => !m.id.startsWith("new-"))).toBe(true);
  });
});
