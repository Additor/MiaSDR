import type { LookupCall } from "./formula-parser";

/**
 * What changed in a LOOKUP source. A formula column depends on a source through the names its LOOKUP calls
 * carry (a table id or name, a column id, key or name), which are resolved at evaluation (decisions.md,
 * LOOKUP resolves names at evaluation). So a dependency is matched by token, and a change lists every token
 * that used to resolve to the source or resolves to it now: a rename lists the old and the new name.
 */
export interface LookupSourceChange {
  /** Table ids and names, in any case. */
  tableTokens: readonly string[];
  /** Column ids, keys and names, in any case. Null means the whole table (rows added, removed or imported). */
  columnTokens: readonly string[] | null;
}

const norm = (token: string) => token.trim().toLowerCase();

/** True when one of the LOOKUP calls reads the table, and a column that changed (any column when `columnTokens` is null). */
export function readsLookupSource(calls: readonly LookupCall[], change: LookupSourceChange): boolean {
  const tables = new Set(change.tableTokens.map(norm));
  const columns = change.columnTokens ? new Set(change.columnTokens.map(norm)) : null;
  return calls.some((call) => {
    if (!tables.has(norm(call.table))) return false;
    if (!columns) return true;
    return columns.has(norm(call.lookupColumn)) || columns.has(norm(call.returnColumn));
  });
}

/** Every token a column answers to. */
export const columnTokens = (column: { id: string; key: string; name: string }): string[] => [column.id, column.key, column.name];

/** Every token a table answers to. */
export const tableTokens = (table: { id: string; name: string }): string[] => [table.id, table.name];
