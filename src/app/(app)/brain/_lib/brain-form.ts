import { BRAIN_FIELDS, brainFieldValue, type BrainField, type BrainFields } from "@/contexts/brain/domain/brain-fields";
import type { BrainItemKind } from "@/contexts/brain/domain/brain-kinds";

/** The Brain form's values as the inputs hold them: text, with a list as one item per line. */
export type BrainFormValues = Record<string, string>;

export function formValuesOf(kind: BrainItemKind, data: BrainFields | null): BrainFormValues {
  const values: BrainFormValues = {};
  for (const field of BRAIN_FIELDS[kind].fields) {
    const value = data ? brainFieldValue(data, field.key) : undefined;
    values[field.key] = value === undefined ? "" : Array.isArray(value) ? value.join("\n") : String(value);
  }
  return values;
}

function valueOf(field: BrainField, text: string): unknown {
  if (field.type === "list") return text.split("\n");
  if (field.type === "number") {
    const trimmed = text.trim();
    if (trimmed === "") return null;
    // Text that is no number goes as it is, so the server names the field. JSON would turn NaN into an empty value.
    return Number.isNaN(Number(trimmed)) ? trimmed : Number(trimmed);
  }
  return text;
}

/** The body's `fields`. A dotted key is a nested object, as `structured_data` stores it. */
export function fieldsOf(kind: BrainItemKind, values: BrainFormValues): BrainFields {
  const fields: BrainFields = {};
  for (const field of BRAIN_FIELDS[kind].fields) {
    const parts = field.key.split(".");
    let at = fields;
    for (const part of parts.slice(0, -1)) at = (at[part] ??= {}) as BrainFields;
    at[parts[parts.length - 1]] = valueOf(field, values[field.key] ?? "");
  }
  return fields;
}

/** Whether the required fields hold something. The server keeps every other rule. */
export const requiredFilled = (kind: BrainItemKind, values: BrainFormValues): boolean => BRAIN_FIELDS[kind].fields.every((field) => !field.required || (values[field.key] ?? "").trim() !== "");
