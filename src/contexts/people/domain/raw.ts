/**
 * Source data kept from an import: every column the user did not map, as text.
 * Bounded so one hostile or careless file cannot bloat a row.
 */
export type RawData = Record<string, string>;

export const RAW_LIMITS = {
  maxKeys: 100,
  maxKeyChars: 100,
  maxValueChars: 2_000,
  /** Sum of key and value lengths. */
  maxTotalChars: 16_000,
} as const;

export interface RawCapResult {
  raw: RawData;
  /** Keys dropped because of the key or total cap. */
  droppedKeys: string[];
  /** Keys whose value was cut to the per-value cap. */
  truncatedKeys: string[];
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Entries are applied in order. A key that no longer fits is dropped whole. */
export function capRaw(entries: Iterable<[string, string | null | undefined]>, seed: RawData = {}): RawCapResult {
  const raw: RawData = Object.create(null);
  let total = 0;
  for (const [key, value] of Object.entries(seed)) {
    raw[key] = value;
    total += key.length + value.length;
  }
  const droppedKeys: string[] = [];
  const truncatedKeys: string[] = [];
  let keys = Object.keys(raw).length;

  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    const value = (rawValue ?? "").trim();
    if (!key || value === "") continue;
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (key.length > RAW_LIMITS.maxKeyChars) {
      droppedKeys.push(key.slice(0, RAW_LIMITS.maxKeyChars));
      continue;
    }
    const cut = value.length > RAW_LIMITS.maxValueChars ? value.slice(0, RAW_LIMITS.maxValueChars) : value;
    const previous = raw[key];
    const isNew = previous === undefined;
    const cost = key.length + cut.length - (isNew ? 0 : key.length + previous.length);
    if ((isNew && keys >= RAW_LIMITS.maxKeys) || total + cost > RAW_LIMITS.maxTotalChars) {
      droppedKeys.push(key);
      continue;
    }
    if (cut !== value) truncatedKeys.push(key);
    raw[key] = cut;
    total += cost;
    if (isNew) keys += 1;
  }
  return { raw: { ...raw }, droppedKeys, truncatedKeys };
}

/** Incoming values replace stored ones key by key; stored keys the file lacks stay. */
export function mergeRaw(existing: Record<string, unknown> | null | undefined, incoming: RawData): RawCapResult {
  const seed: RawData = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (key in incoming || FORBIDDEN_KEYS.has(key)) continue;
    seed[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return capRaw(Object.entries(incoming), seed);
}

/** True when merging `incoming` into `existing` would change nothing. */
export function rawUnchanged(existing: Record<string, unknown> | null | undefined, incoming: RawData): boolean {
  const current = existing ?? {};
  return Object.entries(incoming).every(([key, value]) => current[key] === value);
}

const COMPANY_PREFIX = /^company[\s_-]/i;

/**
 * Splits unmapped columns. Headers that start with "Company " describe the
 * company and go to companies.raw; everything else goes to people.raw.
 */
export function splitUnmapped(
  headers: string[],
  mapping: Record<string, string>,
  row: Record<string, string>,
): { person: Array<[string, string]>; company: Array<[string, string]> } {
  const person: Array<[string, string]> = [];
  const company: Array<[string, string]> = [];
  for (const header of headers) {
    const target = mapping[header];
    if (target && target !== "skip") continue;
    const value = row[header];
    if (value === undefined || value.trim() === "") continue;
    (COMPANY_PREFIX.test(header) ? company : person).push([header, value]);
  }
  return { person, company };
}

/** A raw key becomes a custom field value only as text. Used by the "Map this field" backfill. */
export function rawValueForCustom(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (value === null || value === undefined) return null;
  return String(value);
}
