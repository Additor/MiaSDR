import type { GridRow } from "../data/types";

/**
 * Folds a freshly loaded table page into the rows on screen. The page decides which rows show and in what order;
 * a row keeps its loaded copy when that copy has a newer version, so a table request that read the row before an
 * edit response arrived cannot bring back the older row and its version. `missing` names the loaded rows the page
 * left out (deleted, filtered out or past the page).
 */
export function mergeLoaded(local: readonly GridRow[], page: readonly GridRow[]): { rows: GridRow[]; missing: string[] } {
  const loaded = new Map(local.map((r) => [r.id, r]));
  const rows = page.map((r) => {
    const mine = loaded.get(r.id);
    return mine && mine.version > r.version ? mine : r;
  });
  const shown = new Set(page.map((r) => r.id));
  return { rows, missing: local.filter((r) => !shown.has(r.id)).map((r) => r.id) };
}
