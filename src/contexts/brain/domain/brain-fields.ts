import { ValidationError } from "@/shared/errors";
import type { BrainItemKind } from "./brain-kinds";

/**
 * The fields of each Brain kind. Keys, value types and limits follow the Brain field registry in Withmia, which this
 * product conforms to, so `structured_data` carries over unchanged. The list holds a part of each kind's fields; a later
 * one can be added without touching what is stored. "Brain" in docs/decisions.md.
 */

export type BrainFieldType = "text" | "url" | "number" | "list" | "enum" | "currency";

export interface BrainField {
  /** The key in `structured_data`. A dotted key is stored as a nested object. */
  key: string;
  label: string;
  type: BrainFieldType;
  required?: boolean;
  /** Characters of a text. */
  max?: number;
  options?: readonly { value: string; label: string }[];
}

export interface BrainKindDefinition {
  fields: readonly BrainField[];
  /** The field whose value is the item's title. Without one, a person writes the title. */
  titleField?: string;
}

export type BrainFields = Record<string, unknown>;

const LONG = 5000;
const NAME = 200;
const MAX_LIST_ITEMS = 50;
const MAX_LIST_ITEM = 200;
/** The URL shape Brain in Withmia accepts. */
const URL_PATTERN = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export const OBJECTION_CATEGORIES = [
  { value: "price", label: "Price" },
  { value: "competition", label: "Competition" },
  { value: "timing", label: "Timing" },
  { value: "authority", label: "Authority" },
  { value: "need", label: "Need" },
  { value: "trust", label: "Trust" },
  { value: "status_quo", label: "Status quo" },
  { value: "integration", label: "Integration" },
  { value: "security", label: "Security" },
  { value: "compliance", label: "Compliance" },
  { value: "change_management", label: "Change management" },
  { value: "other", label: "Other" },
] as const;

export const BRAIN_FIELDS: Record<BrainItemKind, BrainKindDefinition> = {
  company_profile: {
    titleField: "companyName",
    fields: [
      { key: "companyName", label: "Company name", type: "text", required: true, max: 100 },
      { key: "website", label: "Website", type: "url", max: 2048 },
      { key: "targetMarket", label: "Target market", type: "text", max: NAME },
      { key: "overview", label: "Overview", type: "text", max: LONG },
      { key: "valueProposition", label: "Value proposition", type: "text", max: LONG },
      { key: "differentiators", label: "Differentiators", type: "text", max: LONG },
    ],
  },
  product: {
    titleField: "productName",
    fields: [
      { key: "productName", label: "Product name", type: "text", required: true, max: NAME },
      { key: "overview", label: "Overview", type: "text", max: LONG },
      { key: "keyFeatures", label: "Key features", type: "text", max: LONG },
      { key: "useCases", label: "Use cases", type: "text", max: LONG },
      { key: "benefitsOutcomes", label: "Benefits and outcomes", type: "text", max: LONG },
    ],
  },
  price_book: {
    titleField: "entryName",
    fields: [
      { key: "entryName", label: "Plan name", type: "text", required: true, max: NAME },
      { key: "productName", label: "Product", type: "text", max: NAME },
      { key: "pricing.currency", label: "Currency", type: "currency" },
      { key: "monthlyPrice", label: "Monthly price", type: "number" },
      { key: "annualPrice", label: "Annual price", type: "number" },
      { key: "features", label: "Features", type: "list" },
      { key: "contractTerms", label: "Contract terms", type: "text", max: 1000 },
      { key: "notes", label: "Notes", type: "text", max: 1000 },
    ],
  },
  icp: {
    titleField: "icpName",
    fields: [
      { key: "icpName", label: "ICP name", type: "text", required: true, max: NAME },
      { key: "industry", label: "Industry", type: "text", max: NAME },
      { key: "companySize", label: "Company size", type: "text", max: NAME },
      { key: "decisionMakerTitles", label: "Decision maker titles", type: "list" },
      { key: "painPoints", label: "Pain points", type: "text", max: LONG },
      { key: "buyingTriggers", label: "Buying triggers", type: "text", max: LONG },
    ],
  },
  competitor: {
    titleField: "competitorName",
    fields: [
      { key: "competitorName", label: "Competitor name", type: "text", required: true, max: NAME },
      { key: "ourStrengthsVsThem", label: "Our strengths against them", type: "text", max: LONG },
      { key: "theirWeaknesses", label: "Their weaknesses", type: "text", max: LONG },
      { key: "battleCard", label: "Battle card", type: "text", max: LONG },
    ],
  },
  case_study: {
    titleField: "customerName",
    fields: [
      { key: "customerName", label: "Customer name", type: "text", required: true, max: NAME },
      { key: "industry", label: "Industry", type: "text", max: NAME },
      { key: "challenge", label: "Challenge", type: "text", required: true, max: LONG },
      { key: "solution", label: "Solution", type: "text", required: true, max: LONG },
      { key: "results", label: "Results", type: "text", required: true, max: LONG },
      { key: "keyMetrics", label: "Key metrics", type: "text", max: LONG },
    ],
  },
  testimonial: {
    titleField: "customerName",
    fields: [
      { key: "customerName", label: "Customer name", type: "text", required: true, max: NAME },
      { key: "contactName", label: "Contact name", type: "text", max: NAME },
      { key: "contactTitle", label: "Contact title", type: "text", max: NAME },
      { key: "quote", label: "Quote", type: "text", required: true, max: LONG },
    ],
  },
  objection_handling: {
    fields: [
      { key: "category", label: "Topic", type: "enum", options: OBJECTION_CATEGORIES },
      { key: "objection", label: "Objection", type: "text", required: true, max: 1000 },
      { key: "responseStrategy", label: "Response strategy", type: "text", required: true, max: LONG },
      { key: "proofPoints", label: "Proof points", type: "text", max: LONG },
      { key: "followUpQuestion", label: "Follow-up question", type: "text", max: 1000 },
    ],
  },
  qualification: {
    fields: [
      { key: "framework", label: "Framework", type: "text", max: NAME },
      { key: "scoringGuidelines", label: "Who to contact and when to hand over", type: "text", max: LONG },
      { key: "disqualificationSignals", label: "Who to leave out", type: "text", max: LONG },
    ],
  },
};

const readPath = (data: BrainFields, key: string): unknown => key.split(".").reduce<unknown>((value, part) => (value && typeof value === "object" ? (value as BrainFields)[part] : undefined), data);

/** Stores `value` under a key of the field list, which a dotted key nests. */
export function writeBrainField(data: BrainFields, key: string, value: unknown): void {
  const parts = key.split(".");
  let at = data;
  for (const part of parts.slice(0, -1)) at = (at[part] ??= {}) as BrainFields;
  at[parts[parts.length - 1]] = value;
}

/** Every leaf key of `raw`, dotted, so a stray nested key is seen. A key that holds a dot itself is never one a field reads, so it is marked as unknown. */
function leafKeys(raw: BrainFields, prefix = ""): string[] {
  return Object.entries(raw).flatMap(([key, value]) => {
    if (key.includes(".")) return [`"${prefix}${key}"`];
    return value && typeof value === "object" && !Array.isArray(value) ? leafKeys(value as BrainFields, `${prefix}${key}.`) : [`${prefix}${key}`];
  });
}

function parseValue(field: BrainField, raw: unknown): unknown {
  const fail = (rule: string): never => {
    throw new ValidationError(`${field.label} ${rule}.`);
  };
  switch (field.type) {
    case "number": {
      if (raw === null || raw === undefined || raw === "") return undefined;
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) fail("must be a number of 0 or more");
      return raw;
    }
    case "list": {
      if (raw === null || raw === undefined) return undefined;
      if (!Array.isArray(raw)) return fail("must be a list");
      const items = (raw as unknown[]).map((item) => (typeof item === "string" ? item.trim() : fail("must be a list of text"))).filter((item) => item !== "");
      if (items.length > MAX_LIST_ITEMS) fail(`can hold at most ${MAX_LIST_ITEMS} items`);
      if (items.some((item) => (item as string).length > MAX_LIST_ITEM)) fail(`items must be at most ${MAX_LIST_ITEM} characters`);
      return items.length === 0 ? undefined : items;
    }
    default: {
      if (raw === null || raw === undefined) return undefined;
      if (typeof raw !== "string") return fail("must be text");
      const text = raw.trim();
      if (text === "") return undefined;
      if (field.max !== undefined && text.length > field.max) fail(`must be at most ${field.max.toLocaleString("en-US")} characters`);
      if (field.type === "url" && !URL_PATTERN.test(text)) fail("must be an http or https address");
      if (field.type === "enum" && !field.options?.some((o) => o.value === text)) fail("is not one of the choices");
      if (field.type === "currency") {
        const code = text.toUpperCase();
        if (!CURRENCY_PATTERN.test(code)) fail("must be a three-letter code such as USD");
        return code;
      }
      return text;
    }
  }
}

/** Rules across the fields of one kind. */
function checkKindRules(kind: BrainItemKind, out: BrainFields): void {
  if (kind === "price_book" && (readPath(out, "monthlyPrice") !== undefined || readPath(out, "annualPrice") !== undefined) && readPath(out, "pricing.currency") === undefined) {
    throw new ValidationError("Currency is required when a plan has a price.");
  }
  if (kind === "qualification" && readPath(out, "scoringGuidelines") === undefined && readPath(out, "disqualificationSignals") === undefined) {
    throw new ValidationError("Write who to contact or who to leave out.");
  }
}

/**
 * The fields of one item, trimmed and in the list's order, or a `ValidationError` naming what is wrong. An empty value
 * means no value, so it is not stored.
 */
export function parseBrainFields(kind: BrainItemKind, raw: BrainFields): BrainFields {
  const { fields } = BRAIN_FIELDS[kind];
  const unknown = leafKeys(raw).find((key) => !fields.some((f) => f.key === key));
  if (unknown !== undefined) throw new ValidationError(`Unknown field: ${unknown}.`);
  const out: BrainFields = {};
  for (const field of fields) {
    const value = parseValue(field, readPath(raw, field.key));
    if (value === undefined) {
      if (field.required) throw new ValidationError(`${field.label} is required.`);
    } else {
      writeBrainField(out, field.key, value);
    }
  }
  checkKindRules(kind, out);
  return out;
}

export const brainFieldValue = readPath;

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, inner]) => [key, sortedKeys(inner)]));
  return value;
}

/**
 * Whether two field values are the same. Postgres reorders `jsonb` keys, so the order does not count. It does not check the
 * rules: an item stored under older limits must still take a valid edit.
 */
export const sameBrainFields = (a: BrainFields, b: BrainFields): boolean => JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));

/** The value as a person reads it: a list on one line, a price with its currency. */
function displayValue(field: BrainField, value: unknown, data: BrainFields): string {
  if (Array.isArray(value)) return value.join(", ");
  if (field.type === "number") {
    const currency = readPath(data, "pricing.currency");
    return typeof currency === "string" ? `${currency} ${String(value)}` : String(value);
  }
  if (field.type === "enum") return field.options?.find((o) => o.value === value)?.label ?? String(value);
  return String(value);
}

/** Label and display value of each field that has a value, in the list's order. */
export function brainFieldRows(kind: BrainItemKind, data: BrainFields): { key: string; label: string; value: string }[] {
  return BRAIN_FIELDS[kind].fields.flatMap((field) => {
    const value = readPath(data, field.key);
    if (value === undefined) return [];
    // The currency reads as part of each price, unless the plan has no price to carry it.
    if (field.type === "currency" && (readPath(data, "monthlyPrice") !== undefined || readPath(data, "annualPrice") !== undefined)) return [];
    return [{ key: field.key, label: field.label, value: displayValue(field, value, data) }];
  });
}

/** The text a prompt reads: one "Label: value" per field. A version stores it, so a past draft cites what the AI saw. */
export const renderBrainContent = (kind: BrainItemKind, data: BrainFields): string =>
  brainFieldRows(kind, data)
    .map((row) => `${row.label}: ${row.value}`)
    .join("\n");
