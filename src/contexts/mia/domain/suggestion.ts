import { BRAIN_FIELDS, brainFieldRows, brainFieldValue, parseBrainFields, sameBrainFields, writeBrainField, type BrainField, type BrainFields } from "@/contexts/brain/domain/brain-fields";
import type { BrainItemKind } from "@/contexts/brain/domain/brain-kinds";
import { ConflictError, ValidationError } from "@/shared/errors";
import { isSameSite } from "./page-url";

/**
 * A suggestion is what Mia offers a person for Brain. It holds each value with the sentence it came from. A person saves it,
 * and these rules decide what the person has to look at first: a number or address the sentence does not contain is the
 * kind of mistake that reaches a customer's mail through a draft.
 */

export const MIA_SUGGESTION_TYPES = ["new_item", "item_change"] as const;
export type MiaSuggestionType = (typeof MIA_SUGGESTION_TYPES)[number];

export const MIA_SUGGESTION_STATUSES = ["open", "accepted", "dismissed"] as const;
export type MiaSuggestionStatus = (typeof MIA_SUGGESTION_STATUSES)[number];

export interface SuggestedField {
  value: unknown;
  /** The sentence the value came from. Null for a choice between fixed options, which no sentence states. */
  quote: string | null;
  /** The page it came from. Null when it came from text a person gave. A page here is one Mia read, so it can be a link. */
  sourceUrl: string | null;
  /** The value holds a number, address or currency its sentence does not contain. A person has to confirm it. */
  unverified: boolean;
}

export interface SuggestionPayload {
  /** By field key, dotted where the key is. */
  fields: Record<string, SuggestedField>;
  /** The document is from before the kinds existed, so accepting it also sets the kind. */
  sorting: boolean;
}

export interface FieldInput {
  key: string;
  value: unknown;
  quote: string;
  /** A page address Mia read, or `INPUT_SOURCE` for the text a person gave. */
  source: string;
}

export const INPUT_SOURCE = "input";

const squeeze = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Digit groups as a person reads them: 1,000 and 1000 are one number, and so are 99.00 and 99. */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0{1,2}$/, "").replace(/(\.\d)0$/, "$1"));
}

/**
 * Web addresses with or without a scheme, and the domain of a mail address. "Book at evil.test" written into a value is
 * the mistake this check exists for. The lookbehind tries a name only from its start, so a long word costs one pass.
 */
const ADDRESS = /https?:\/\/[^\s)>"']+|(?<![a-z0-9-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#][^\s)>"']*)?/gi;

const addressesIn = (text: string): string[] => text.match(ADDRESS) ?? [];

const CURRENCY_SIGNS: Record<string, readonly string[]> = { USD: ["$"], EUR: ["€"], GBP: ["£"], JPY: ["¥", "円"], KRW: ["₩", "원"], CNY: ["¥", "元"] };

const textOf = (value: unknown): string => (Array.isArray(value) ? value.join("\n") : String(value));

/** Whether the sentence holds what is checkable in the value: its numbers, its addresses, its currency. Wording may differ. */
function valueIsInQuote(field: BrainField, value: unknown, quote: string, sourceUrl: string | null): boolean {
  const text = textOf(value);
  if (field.type === "currency") {
    const code = text.toUpperCase();
    // Whole words, since "Europe" does not state EUR.
    return quote.toUpperCase().split(/[^A-Z]+/).includes(code) || (CURRENCY_SIGNS[code] ?? []).some((sign) => quote.includes(sign));
  }
  if (field.type === "url" && sourceUrl) {
    try {
      if (isSameSite(new URL(text), new URL(sourceUrl))) return true;
    } catch {
      return false;
    }
  }
  const quoted = new Set(numbersIn(quote));
  if (numbersIn(text).some((n) => !quoted.has(n))) return false;
  const low = quote.toLowerCase();
  return addressesIn(text).every((address) => low.includes(address.toLowerCase()));
}

export interface ReviewedSuggestion {
  fields: Record<string, SuggestedField>;
  /** What the model sent, in `structured_data` form. */
  parsed: BrainFields;
}

/**
 * Checks what a model offered. A value with no sentence behind it, or a sentence no source contains, is refused and the
 * reason goes back to the model. A value its sentence does not fully support stays, marked for a person. `sources` maps
 * each source to its text. It reads only what the model sent and never what an item holds, so the answer a run gets says
 * nothing about Brain, and a suggestion that changes an item restates that kind's required fields.
 */
export function reviewSuggestion(kind: BrainItemKind, inputs: readonly FieldInput[], sources: ReadonlyMap<string, string>): ReviewedSuggestion {
  const definitions = new Map(BRAIN_FIELDS[kind].fields.map((field) => [field.key, field]));
  const fields: Record<string, SuggestedField> = {};
  const raw: BrainFields = {};
  if (inputs.length === 0) throw new ValidationError("Suggest at least one field.");
  for (const input of inputs) {
    const field = definitions.get(input.key);
    if (!field) throw new ValidationError(`Unknown field: ${input.key}.`);
    if (field.type === "enum") {
      fields[input.key] = { value: input.value, quote: null, sourceUrl: null, unverified: false };
      writeBrainField(raw, input.key, input.value);
      continue;
    }
    const source = sources.get(input.source);
    if (source === undefined) throw new ValidationError(`${field.label}: "${input.source}" is not a source you read.`);
    const quote = input.quote.trim();
    if (quote === "") throw new ValidationError(`${field.label} needs the sentence it came from.`);
    if (!squeeze(source).includes(squeeze(quote))) throw new ValidationError(`${field.label}: that sentence is not in the source. Quote it exactly.`);
    const sourceUrl = input.source === INPUT_SOURCE ? null : input.source;
    fields[input.key] = { value: input.value, quote, sourceUrl, unverified: !valueIsInQuote(field, input.value, quote, sourceUrl) };
    writeBrainField(raw, input.key, input.value);
  }
  return { fields, parsed: parseBrainFields(kind, raw) };
}

export interface SuggestionRow {
  key: string;
  label: string;
  field: BrainField;
  /** What the item holds now, as a person reads it. Empty for a value it does not have. */
  current: string;
  proposed: string;
  quote: string | null;
  sourceUrl: string | null;
  unverified: boolean;
}

/** The fields this suggestion sets, beside what the item holds now, for a person to compare. Fields it does not name stay as they are. */
export function suggestionRows(kind: BrainItemKind, payload: SuggestionPayload, current: BrainFields | null): SuggestionRow[] {
  const now = new Map(current ? brainFieldRows(kind, current).map((row) => [row.key, row.value]) : []);
  return BRAIN_FIELDS[kind].fields.flatMap((field) => {
    const suggested = payload.fields[field.key];
    if (!suggested) return [];
    // A priced plan shows its currency inside each price, so the currency has no row of its own.
    const stored = current ? brainFieldValue(current, field.key) : undefined;
    const holds = now.get(field.key) ?? (stored === undefined ? "" : textOf(stored));
    return [{ key: field.key, label: field.label, field, current: holds, proposed: textOf(suggested.value), quote: suggested.quote, sourceUrl: suggested.sourceUrl, unverified: suggested.unverified }];
  });
}

/**
 * An unverified value goes in only when a person changed it or ticked it. The form starts with what Mia suggested, so a save
 * without either would be Mia's unchecked number.
 */
export function checkConfirmed(kind: BrainItemKind, payload: SuggestionPayload, saving: BrainFields, confirmed: readonly string[]): void {
  const unchecked = BRAIN_FIELDS[kind].fields.filter((field) => {
    const suggested = payload.fields[field.key];
    if (!suggested?.unverified || confirmed.includes(field.key)) return false;
    return sameBrainFields({ value: brainFieldValue(saving, field.key) ?? null }, { value: suggested.value });
  });
  if (unchecked.length > 0) throw new ConflictError(`Check ${unchecked.map((f) => f.label).join(", ")} against the source first.`, { code: "mia_unconfirmed", fields: unchecked.map((f) => f.key) });
}
