import { z } from "zod";
import { MAX_LINKEDIN_REPLY } from "../../domain/linkedin-reply";

/**
 * What the AI may return and what it may be shown. The classification output is a closed set:
 * one active subcategory key (the category follows from it), a confidence and a short reason.
 * Nothing in a model answer can name a category outside the pipeline, trigger a send or add a field.
 */

export const MAX_REASON_LENGTH = 500;
export const MAX_DRAFT_BODY = 20_000;

export function classificationSchema(keys: readonly string[]) {
  if (keys.length === 0) throw new Error("The reply categories need at least one active subcategory to classify into.");
  return z.strictObject({
    subcategoryKey: z.enum(keys as [string, ...string[]]),
    confidence: z.number().finite().min(0).max(1),
    reason: z
      .string()
      .trim()
      .min(1)
      .transform((s) => s.slice(0, MAX_REASON_LENGTH)),
  });
}

export type ClassifyOutput = z.infer<ReturnType<typeof classificationSchema>>;

/** JSON Schema sent to the provider. Range and length rules stay out of it (the API rejects them); zod enforces them afterwards. */
export function classificationJsonSchema(keys: readonly string[]) {
  return {
    type: "object",
    properties: {
      subcategoryKey: { type: "string", enum: [...keys] },
      confidence: { type: "number", description: "Between 0 and 1." },
      reason: { type: "string", description: "One or two sentences, at most 500 characters." },
    },
    required: ["subcategoryKey", "confidence", "reason"],
    additionalProperties: false,
  } as const;
}

export const draftSchema = z.strictObject({
  subject: z.string().trim().max(300),
  bodyText: z.string().trim().min(1).max(MAX_DRAFT_BODY),
});

export type DraftOutput = z.infer<typeof draftSchema>;

/** Channels the AI drafts for. */
export type DraftChannel = "email" | "linkedin";

/**
 * A LinkedIn message has no subject and a hard length limit. A model that still returns a `subject` is tolerated and
 * the field is dropped, so a drifting answer does not fail the job. The body must fit LinkedIn's limit.
 */
export const linkedinDraftSchema = z.object({
  subject: z.string().optional(),
  bodyText: z.string().trim().min(1).max(MAX_LINKEDIN_REPLY),
});

export const LINKEDIN_DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    bodyText: { type: "string", description: "Plain text message, short, no subject line, no signature." },
  },
  required: ["bodyText"],
  additionalProperties: false,
} as const;

export const DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Subject line for the reply." },
    bodyText: { type: "string", description: "Plain text body of the reply, without signature." },
  },
  required: ["subject", "bodyText"],
  additionalProperties: false,
} as const;

export interface TaxonomyEntry {
  key: string;
  name: string;
  categoryKey: string;
  description: string | null;
  guidance: string | null;
}

export interface ThreadEntry {
  direction: "inbound" | "outbound";
  at: Date;
  subject: string | null;
  text: string;
}

export interface AiPersonContext {
  name: string | null;
  email: string | null;
  title: string | null;
  company: string | null;
}

export interface ClassifyInput {
  taxonomy: TaxonomyEntry[];
  person: AiPersonContext;
  /** Oldest first. The last inbound entry is the message to classify. */
  thread: ThreadEntry[];
  /** Organization-written rules. Trusted as guidance, never as a way to widen the output set. */
  operatorInstructions: string;
  businessContext: string;
}

/** A person moved the record to another stage after the last inbound message, because something happened off the thread. */
export interface StageChange {
  /** Name of the stage the record moved to. */
  stage: string;
  occurredAt: Date;
  note: string | null;
}

export interface DraftInput {
  /** Decides the prompt rules and the answer shape. LinkedIn drafts have no subject and are short plain text. */
  channel: DraftChannel;
  person: AiPersonContext;
  thread: ThreadEntry[];
  /** Empty for LinkedIn. */
  subject: string;
  classification: { subcategoryName: string; reason: string | null } | null;
  /** The newest stage move since the last inbound message, or null. The classifier's reason is dropped when it is set. */
  stageChange: StageChange | null;
  operatorInstructions: string;
  knowledge: Array<{ title: string; content: string }>;
  /** Reviewer feedback for a regeneration, with the draft it applies to. */
  feedback: string | null;
  previousDraft: string | null;
  senderName: string | null;
}

/** A free-form question over a few cell values, used by the grid's AI columns. */
export interface AnswerField {
  key: string;
  /** Email, url, date and json travel as text. The caller checks and converts them (grid: ai-output-coerce.ts). */
  type: "text" | "number" | "boolean" | "email" | "url" | "date" | "json";
  description?: string;
}

export interface AnswerInput {
  /** Written by a member of the organization. Trusted as guidance, never as a way to widen the output fields. */
  instruction: string;
  /** Cell values from a table. Anyone may have written them, so they are fenced as untrusted data. */
  cells: Array<{ key: string; value: string }>;
  outputs: AnswerField[];
}

export type AnswerOutput = Record<string, string | number | boolean | null>;

/**
 * Closed output: exactly the requested fields, each nullable so the model can say "not found". Text has no length cap
 * here: a shape failure is transient and retries a paid call, so the caller (grid: ai-output-coerce.ts) rejects an
 * over-long value as a cell error instead. The model's max_tokens bounds the size.
 */
export function answerSchema(outputs: readonly AnswerField[]) {
  if (outputs.length === 0) throw new Error("An answer needs at least one output field.");
  const shape: Record<string, z.ZodType> = {};
  for (const f of outputs) {
    const base = f.type === "number" ? z.number().finite() : f.type === "boolean" ? z.boolean() : z.string();
    shape[f.key] = base.nullable();
  }
  return z.strictObject(shape);
}

const WIRE_TYPE = { number: "number", boolean: "boolean" } as const;
const TYPE_HINT: Partial<Record<AnswerField["type"], string>> = {
  email: "A single email address.",
  url: "A full URL that starts with http:// or https://.",
  date: "A calendar date written as YYYY-MM-DD.",
  json: "A valid JSON value written as text.",
};

export function answerJsonSchema(outputs: readonly AnswerField[]) {
  return {
    type: "object",
    properties: Object.fromEntries(
      outputs.map((f) => [f.key, { type: [WIRE_TYPE[f.type as keyof typeof WIRE_TYPE] ?? "string", "null"], description: [f.description, TYPE_HINT[f.type], "null when it is not known or cannot be found. Never guess."].filter(Boolean).join(" ") }]),
    ),
    required: outputs.map((f) => f.key),
    additionalProperties: false,
  } as const;
}
