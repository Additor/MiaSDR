import { placeAfter } from "./keys";

export interface ChainPlacement {
  /** Position of each new column, in the order they are created. */
  positions: number[];
  /** Existing siblings that move so the chain fits. Applied under the same table lock as the insert. */
  renumber: Array<{ id: string; position: number }>;
}

/**
 * Places `count` new columns in a row right after `afterColumnId` (or at the end), each one after the previous,
 * the way an enrichment or AI column and its outputs sit together. When the gap runs out the siblings are
 * renumbered; the new columns' own positions already include every renumber.
 */
export function chainPlacement(existing: ReadonlyArray<{ id: string; position: number }>, count: number, afterColumnId?: string | null): ChainPlacement {
  let working = existing.map((c) => ({ id: c.id, position: c.position })).sort((a, b) => a.position - b.position);
  const moved = new Map<string, number>();
  const ids: string[] = [];
  let anchor = afterColumnId ?? null;
  for (let i = 0; i < count; i += 1) {
    const placed = placeAfter(working, anchor);
    for (const move of placed.renumber) moved.set(move.id, move.position);
    const byId = new Map(placed.renumber.map((m) => [m.id, m.position]));
    const id = `new-${i}`;
    working = [...working.map((c) => ({ id: c.id, position: byId.get(c.id) ?? c.position })), { id, position: placed.position }].sort((a, b) => a.position - b.position);
    ids.push(id);
    anchor = id;
  }
  const finalOf = new Map(working.map((c) => [c.id, c.position]));
  const real = new Set(existing.map((c) => c.id));
  return {
    positions: ids.map((id) => finalOf.get(id) ?? 0),
    renumber: [...moved].filter(([id]) => real.has(id)).map(([id, position]) => ({ id, position })),
  };
}
