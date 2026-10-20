import { ValidationError } from "@/shared/errors";

/** Column keys, display names and fractional positions. All pure. */

/** Longest name accepted for a folder, workbook, table or column. */
export const MAX_NAME_LENGTH = 200;

/**
 * What a column key may contain: letters, digits and combining marks of any script, plus underscore.
 * This is the one definition. The formula parser, the config dependency scan and the template renderer
 * all read keys through KEY_CHAR, TOKEN, SINGLE_TOKEN or scanKey, so they cannot drift apart.
 */
export const KEY_CHAR = "[\\p{L}\\p{N}\\p{M}_]";

/** `{{key}}` anywhere in a text. Global: use with matchAll or replace, which do not leak lastIndex. */
export const TOKEN = new RegExp(`\\{\\{\\s*(${KEY_CHAR}+)\\s*\\}\\}`, "gu");

/** A text that is exactly one `{{key}}`. */
export const SINGLE_TOKEN = new RegExp(`^\\{\\{\\s*(${KEY_CHAR}+)\\s*\\}\\}$`, "u");

const KEY_RUN = new RegExp(`${KEY_CHAR}+`, "uy");

/** The run of key characters starting at `start` (astral characters included), or "" when there is none. */
export function scanKey(source: string, start: number): string {
  KEY_RUN.lastIndex = start;
  return KEY_RUN.exec(source)?.[0] ?? "";
}

/** Column keys are stored NFC. A token typed or pasted as NFD (macOS file names, some IMEs) must match them. */
export const normalizeKey = (key: string): string => key.normalize("NFC");

const MAX_KEY_LENGTH = 60;

const WORD_SPLIT = /[^\p{L}\p{N}\p{M}]+/u;
const HAS_BASE = /[\p{L}\p{N}]/u;

/**
 * "Job Title" becomes "jobTitle", "회사 이름" becomes "회사이름". Words of any script join in order; scripts without
 * case keep their characters. A key that starts with a digit gets a "c" prefix so it stays a readable {{token}}.
 * Input is NFC-normalized so composed and decomposed Hangul give the same key.
 */
export function toColumnKey(label: string): string {
  const words = label
    .normalize("NFC")
    .split(WORD_SPLIT)
    .filter((w) => HAS_BASE.test(w));
  const key = words
    .map((w, i) => {
      if (i === 0) return w.toLowerCase();
      const [first, ...rest] = Array.from(w);
      return first.toUpperCase() + rest.join("").toLowerCase();
    })
    .join("")
    .normalize("NFC");
  return /^\p{N}/u.test(key) ? `c${key}` : key;
}

/** Appends a numeric suffix until the key is free within the table. Caps the base at 60 code points. */
export function uniqueColumnKey(label: string, taken: ReadonlySet<string>): string {
  const base = Array.from(toColumnKey(label) || "column").slice(0, MAX_KEY_LENGTH).join("");
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

/** "Text" then "Text 2" then "Text 3": the first free display name, compared case-insensitively. */
export function uniqueColumnName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const base = name.trim();
  if (!used.has(base.toLowerCase())) return base;
  let n = 2;
  while (used.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}

/**
 * Position midway between the anchor and the next item, so an insert never renumbers a neighbour.
 * `atStartWhenNoAnchor` separates "append" (new column) from "move to front" (reorder with a null anchor).
 */
export function positionAfter(ordered: ReadonlyArray<{ id: string; position: number }>, afterId?: string | null, atStartWhenNoAnchor = false): number {
  if (!afterId) {
    if (ordered.length === 0) return 1;
    return atStartWhenNoAnchor ? ordered[0].position / 2 : ordered[ordered.length - 1].position + 1;
  }
  const index = ordered.findIndex((c) => c.id === afterId);
  if (index === -1) return (ordered[ordered.length - 1]?.position ?? 0) + 1;
  const before = ordered[index].position;
  const after = ordered[index + 1]?.position;
  return after === undefined ? before + 1 : (before + after) / 2;
}

/** Position immediately before an existing item without renumbering the others. */
export function positionBefore(ordered: ReadonlyArray<{ id: string; position: number }>, beforeId: string): number {
  const index = ordered.findIndex((c) => c.id === beforeId);
  if (index === -1) return (ordered[ordered.length - 1]?.position ?? 0) + 1;
  if (index === 0) return ordered[0].position / 2;
  return (ordered[index - 1].position + ordered[index].position) / 2;
}

/** Two neighbours closer than this get renumbered. A double halves about 50 times before a midpoint collides. */
export const MIN_POSITION_GAP = 1e-6;

export interface Placement {
  position: number;
  /** Siblings whose position changes so the new item fits. Empty while the midpoint is still clear of both neighbours. */
  renumber: Array<{ id: string; position: number }>;
}

/**
 * Puts a new item at `slot` (0 is the front, `ordered.length` the end). The midpoint wins while it keeps
 * MIN_POSITION_GAP from both neighbours; otherwise every sibling is renumbered 1..n around the slot.
 * The slot is an index, so siblings that already share a position are handled.
 */
function placeAt(ordered: ReadonlyArray<{ id: string; position: number }>, slot: number): Placement {
  const before = ordered[slot - 1]?.position;
  const after = ordered[slot]?.position;
  let position: number;
  if (before === undefined) position = after === undefined ? 1 : after / 2;
  else position = after === undefined ? before + 1 : (before + after) / 2;
  const clear = (before === undefined || position - before >= MIN_POSITION_GAP) && (after === undefined || after - position >= MIN_POSITION_GAP) && position > 0;
  if (clear) return { position, renumber: [] };
  const renumber: Placement["renumber"] = [];
  ordered.forEach((item, index) => {
    const next = index < slot ? index + 1 : index + 2;
    if (item.position !== next) renumber.push({ id: item.id, position: next });
  });
  return { position: slot + 1, renumber };
}

/** Like positionAfter, with a renumber of the siblings when the gap has run out. `ordered` is sorted by position. */
export function placeAfter(ordered: ReadonlyArray<{ id: string; position: number }>, afterId?: string | null, atStartWhenNoAnchor = false): Placement {
  if (!afterId) return placeAt(ordered, atStartWhenNoAnchor ? 0 : ordered.length);
  const index = ordered.findIndex((c) => c.id === afterId);
  return placeAt(ordered, index === -1 ? ordered.length : index + 1);
}

/** Like positionBefore, with a renumber of the siblings when the gap has run out. */
export function placeBefore(ordered: ReadonlyArray<{ id: string; position: number }>, beforeId: string): Placement {
  const index = ordered.findIndex((c) => c.id === beforeId);
  return placeAt(ordered, index === -1 ? ordered.length : index);
}

export function cleanName(value: unknown, label: string, fallback?: string): string {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`${label} cannot be empty`);
  }
  if (typeof value !== "string") throw new ValidationError(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_NAME_LENGTH) throw new ValidationError(`${label} must be ${MAX_NAME_LENGTH} characters or fewer`);
  return trimmed;
}
