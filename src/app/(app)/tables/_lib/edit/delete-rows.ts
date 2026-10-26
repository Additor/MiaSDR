import { GRID_LIMITS } from "@/contexts/grid/application/limits";

const count = (n: number) => n.toLocaleString("en-US");
const rows = (n: number) => `${count(n)} ${n === 1 ? "row" : "rows"}`;

/** Rows per DELETE request. */
export const DELETE_BATCH = GRID_LIMITS.deleteRows;

/** Dialog title that names the count and the table: `Delete 1 row from "Leads"?` */
export function deleteRowsTitle(selected: number, tableName: string): string {
  return `Delete ${rows(selected)} from "${tableName}"?`;
}

export type DeleteRowsReport =
  | { kind: "success"; message: string }
  /** Some batches went through and a later one failed. */
  | { kind: "partial"; message: string }
  /** The first batch failed, so nothing was deleted. */
  | { kind: "failed"; message: string };

/**
 * Turns the outcome of a batched delete into the message to show. `deleted` is the rows the server reported removed,
 * `failed` the rows in the batch that errored and in every batch after it, and `error` that batch's message (null when
 * every batch worked). A success toast belongs only to the success report.
 */
export function deleteRowsReport(deleted: number, failed: number, error: string | null): DeleteRowsReport {
  if (!error) return { kind: "success", message: deleted > 0 ? `Deleted ${rows(deleted)}.` : "Those rows were already deleted." };
  const problem = error.trim().replace(/\.$/, "") || "The server did not respond";
  if (deleted === 0) return { kind: "failed", message: `Could not delete ${rows(failed)}. ${problem}. Try again.` };
  return { kind: "partial", message: `Deleted ${rows(deleted)}, but ${rows(failed)} could not be deleted. ${problem}. They stay selected, so you can try again.` };
}
