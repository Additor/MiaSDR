import { GRID_LIMITS } from "@/contexts/grid/application/limits";

/** The "Add N rows" control: what the field accepts and how many pages the grid loads to reach the new rows. */

/** The server refuses more. */
export const MAX_ADD_ROWS = GRID_LIMITS.addRows;

export type RowCountResult = { ok: true; count: number } | { ok: false; error: string };

/** A whole number from 1 to 1,000. Spaces and thousands commas are fine ("1,000"); anything else is an error with a reason. */
export function parseRowCount(text: string, max = MAX_ADD_ROWS): RowCountResult {
  const cleaned = text.trim().replace(/,/g, "");
  if (cleaned === "") return { ok: false, error: "Enter how many rows to add." };
  if (!/^\d+$/.test(cleaned)) return { ok: false, error: "Use a whole number, such as 250." };
  const count = Number(cleaned);
  if (count < 1) return { ok: false, error: "Add at least 1 row." };
  if (count > max) return { ok: false, error: `Add at most ${max.toLocaleString("en-US")} rows at a time.` };
  return { ok: true, count };
}

export type SubmitPlan = { kind: "skip" } | { kind: "error"; error: string } | { kind: "add"; count: number };

/**
 * What a submit does. A request already in flight wins over everything else: Enter pressed twice before React
 * re-renders would otherwise send the add twice (2,000 rows for one press of "Add 1,000 rows").
 */
export function planSubmit(inFlight: boolean, text: string): SubmitPlan {
  if (inFlight) return { kind: "skip" };
  const parsed = parseRowCount(text);
  return parsed.ok ? { kind: "add", count: parsed.count } : { kind: "error", error: parsed.error };
}

/**
 * Page loads needed so the last row is in the grid: the rows still missing after the first page, in pages,
 * capped so a 50,000-row table does not fire hundreds of requests. Past the cap the grid ends where it stopped
 * and the person scrolls on.
 */
export function pagesToReachEnd(total: number, loaded: number, pageSize: number, cap = 25): number {
  if (total <= loaded || pageSize <= 0) return 0;
  return Math.min(cap, Math.ceil((total - loaded) / pageSize));
}
