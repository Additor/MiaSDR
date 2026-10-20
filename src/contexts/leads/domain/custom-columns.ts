import { customColumnKey } from "./normalize";

/**
 * Rules for the custom column registry. A column is a label plus an immutable key; values live under
 * the key in `people.custom` or `companies.custom`. Renaming changes the label only, so every stored
 * value stays reachable and merge fields keep working.
 */

export const COLUMN_ENTITIES = ["people", "companies"] as const;
export type ColumnEntity = (typeof COLUMN_ENTITIES)[number];

/** The import route accepts custom targets up to this length, so a column made there always fits. */
export const MAX_COLUMN_NAME = 60;
/** Keeps a generated key with its collision suffix well under any index limit. */
const MAX_KEY = 48;

export interface ColumnShape {
  id: string;
  key: string;
  name: string;
  isCore: boolean;
  archivedAt: Date | null;
}

export type NameCheck = { ok: true; name: string } | { ok: false; problem: string };

/** Trims and collapses inner whitespace. Returns the stored label or the reason it is refused. */
export function cleanColumnName(raw: string): NameCheck {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, problem: "Give the column a name." };
  if (name.length > MAX_COLUMN_NAME) return { ok: false, problem: `The name is longer than ${MAX_COLUMN_NAME} characters.` };
  if (customColumnKey(name) === null) return { ok: false, problem: "Use at least one letter or number in the name." };
  return { ok: true, name };
}

/** Case-insensitive comparison form of a label. */
export const nameFold = (name: string): string => name.replace(/\s+/g, " ").trim().toLocaleLowerCase();

/** The column that already uses this name, ignoring case and the column being renamed. Archived columns count. */
export function findDuplicate<T extends ColumnShape>(name: string, columns: readonly T[], exceptId?: string): T | undefined {
  const folded = nameFold(name);
  return columns.find((c) => c.id !== exceptId && nameFold(c.name) === folded);
}

/**
 * The key for a new column: the same derivation an import uses, so a later import of the same label
 * lands in this column. Labels that differ only in punctuation ("Plan", "Plan!") share a derived key,
 * so the later one gets a numeric suffix. Null when the label yields no key.
 */
export function newColumnKey(name: string, existingKeys: Iterable<string>): string | null {
  const base = customColumnKey(name);
  if (base === null) return null;
  const taken = new Set(existingKeys);
  const root = base.slice(0, MAX_KEY);
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Only an archived column can be deleted, so a live column never loses its values by one click. */
export function deleteBlocker(column: Pick<ColumnShape, "archivedAt" | "isCore">): string | null {
  if (column.isCore) return "Built-in fields cannot be deleted.";
  if (!column.archivedAt) return "Archive the field first. Deleting removes its values from every row.";
  return null;
}

export function archiveBlocker(column: Pick<ColumnShape, "archivedAt" | "isCore">): string | null {
  if (column.isCore) return "Built-in fields cannot be archived.";
  return column.archivedAt ? "The column is already archived." : null;
}

export function renameBlocker(column: Pick<ColumnShape, "isCore">): string | null {
  return column.isCore ? "Built-in fields cannot be renamed." : null;
}

/** True when `ids` lists every active column exactly once. */
export function isCompleteOrder(ids: readonly string[], active: readonly Pick<ColumnShape, "id">[]): boolean {
  if (new Set(ids).size !== ids.length || ids.length !== active.length) return false;
  const known = new Set(active.map((c) => c.id));
  return ids.every((id) => known.has(id));
}
