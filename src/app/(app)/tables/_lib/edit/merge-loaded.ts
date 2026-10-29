import type { GridRow } from "../data/types";

/**
 * Folds a new table page into the rows on screen. The page decides which rows show and in what order;
 * a row keeps its loaded copy when that copy has a newer version, so a table request that read the row before an
 * edit response arrived cannot bring back the older row and its version.
 */
export function mergeLoaded(local: readonly GridRow[], page: readonly GridRow[]): GridRow[] {
  const loaded = new Map(local.map((r) => [r.id, r]));
  return page.map((r) => {
    const mine = loaded.get(r.id);
    return mine && mine.version > r.version ? mine : r;
  });
}
