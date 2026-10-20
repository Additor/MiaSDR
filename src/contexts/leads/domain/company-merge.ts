import { blankToNull } from "./normalize";
import { mergeRaw, RAW_LIMITS, type RawData } from "./raw";

/*
 * The value rules of a company merge ("Contacts and Companies CRUD" in docs/decisions.md). You pick the
 * company to keep. Its non-empty values stay; the other company's value fills a field that is empty or missing on the kept
 * one. Name, LinkedIn page and every company field key follow that rule, archived fields included. Raw import data merges
 * with `mergeRaw(other.raw, kept.raw)`, so the kept keys win and the cap drops the other's keys.
 */

/** One side of the merge as stored. */
export interface MergeSide {
  name: string | null;
  linkedinUrl: string | null;
  custom: Record<string, unknown> | null;
  raw: Record<string, unknown> | null;
}

/** A company field of the organization, in Settings order. */
export interface CompanyFieldInfo {
  key: string;
  name: string;
}

/** Both companies hold a value: the kept one stays and the other's is dropped. */
export interface FieldConflict {
  key: string;
  name: string;
  kept: string;
  other: string;
}

/** The kept company had no value and takes the other's. */
export interface FilledField {
  key: string;
  name: string;
  value: string;
}

export interface CompanyMergePlan {
  name: string | null;
  linkedinUrl: string | null;
  custom: Record<string, unknown>;
  raw: RawData | null;
  fieldConflicts: FieldConflict[];
  filledFields: FilledField[];
  /** The other company's raw keys that did not fit under the cap, with their values. */
  rawDropped: RawData;
  /** The other company's raw keys that the kept company also holds with another value, with the other's value. */
  rawOverwritten: RawData;
}

/** The keys of the two built-in values in conflicts and filled fields. Company field keys start with `x_`, so they never clash. */
export const NAME_KEY = "name";
export const LINKEDIN_KEY = "linkedin_url";

/** A stored value as text, or null when it is empty. */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return blankToNull(value);
  return JSON.stringify(value);
}

function asRaw(raw: Record<string, unknown> | null): RawData {
  const out: RawData = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const text = asText(value);
    if (text !== null) out[key] = text;
  }
  return out;
}

/**
 * Merges the raw data under the caps of `raw.ts`. The other company's own keys go in while they fit beside the kept ones, so the
 * cap never drops a kept key; then `mergeRaw` lays the kept keys over the other's.
 */
export function mergeCompanyRaw(kept: Record<string, unknown> | null, other: Record<string, unknown> | null): { raw: RawData | null; dropped: RawData; overwritten: RawData } {
  if (kept === null && other === null) return { raw: null, dropped: {}, overwritten: {} };
  const keptRaw = asRaw(kept);
  const otherRaw = asRaw(other);
  const dropped: RawData = {};
  const overwritten: RawData = {};
  let keys = Object.keys(keptRaw).length;
  let total = Object.entries(keptRaw).reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  const fitting: RawData = {};
  for (const [key, value] of Object.entries(otherRaw)) {
    if (key in keptRaw) {
      // Kept in the call, so `mergeRaw` decides between the two values.
      fitting[key] = value;
      if (keptRaw[key] !== value) overwritten[key] = value;
      continue;
    }
    if (keys + 1 > RAW_LIMITS.maxKeys || total + key.length + value.length > RAW_LIMITS.maxTotalChars) {
      dropped[key] = value;
      continue;
    }
    fitting[key] = value;
    keys += 1;
    total += key.length + value.length;
  }
  const merged = mergeRaw(fitting, keptRaw);
  for (const key of merged.droppedKeys) if (otherRaw[key] !== undefined && !(key in keptRaw)) dropped[key] = otherRaw[key];
  return { raw: merged.raw, dropped, overwritten };
}

/** The values the kept company holds after the merge, and what the preview and the audit row report. */
export function planCompanyMerge(kept: MergeSide, other: MergeSide, fields: readonly CompanyFieldInfo[]): CompanyMergePlan {
  const fieldConflicts: FieldConflict[] = [];
  const filledFields: FilledField[] = [];

  const pick = (key: string, name: string, keptValue: unknown, otherValue: unknown): unknown => {
    const keptText = asText(keptValue);
    const otherText = asText(otherValue);
    if (keptText !== null) {
      if (otherText !== null && otherText !== keptText) fieldConflicts.push({ key, name, kept: keptText, other: otherText });
      return keptValue;
    }
    if (otherText !== null) {
      filledFields.push({ key, name, value: otherText });
      return otherValue;
    }
    return keptValue ?? null;
  };

  const name = pick(NAME_KEY, "name", kept.name, other.name) as string | null;
  const linkedinUrl = pick(LINKEDIN_KEY, "LinkedIn page", kept.linkedinUrl, other.linkedinUrl) as string | null;

  const keptCustom = kept.custom ?? {};
  const otherCustom = other.custom ?? {};
  const names = new Map(fields.map((field) => [field.key, field.name]));
  const known = fields.map((field) => field.key);
  const rest = [...new Set([...Object.keys(keptCustom), ...Object.keys(otherCustom)])].filter((key) => !names.has(key)).sort();
  const custom: Record<string, unknown> = {};
  for (const key of [...known, ...rest]) {
    if (!(key in keptCustom) && !(key in otherCustom)) continue;
    const value = pick(key, names.get(key) ?? key, keptCustom[key], otherCustom[key]);
    if (asText(value) !== null) custom[key] = value;
  }

  const raw = mergeCompanyRaw(kept.raw, other.raw);
  return { name, linkedinUrl, custom, raw: raw.raw, fieldConflicts, filledFields, rawDropped: raw.dropped, rawOverwritten: raw.overwritten };
}
