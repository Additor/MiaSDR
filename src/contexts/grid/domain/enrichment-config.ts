import { z } from "zod";
import { SIMPLE_ADAPTER_KEYS, type ActionSpec } from "./enrichment-catalog";
import { HEADER_NAME, QUERY_PARAM_NAME } from "./enrichment-url-policy";
import { TOKEN, normalizeKey } from "./keys";

/** Column configs for the three enrichment column types, and the provider config for the generic HTTP adapter. */

const columnKey = z.string().min(1).max(80);
const slug = z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/);
const actionKey = z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/);

export const enrichmentConfigSchema = z.strictObject({
  providerKey: slug,
  actionKey,
  /** Action input key to the column that feeds it. */
  inputs: z.record(z.string().min(1).max(60), columnKey),
  /** Action output key to the integration_output column that receives it. */
  outputs: z.record(z.string().min(1).max(60), columnKey).default({}),
  delaySeconds: z.number().int().min(0).max(3600).optional(),
});
export type EnrichmentConfig = z.infer<typeof enrichmentConfigSchema>;

export const waterfallConfigSchema = z.strictObject({
  /** Logical input key to column. Every step reads its action inputs from these. */
  inputs: z.record(z.string().min(1).max(60), columnKey),
  steps: z.array(z.strictObject({ providerKey: slug, actionKey })).min(1).max(8),
  outputs: z.record(z.string().min(1).max(60), columnKey).default({}),
  /** Cents one cell may spend across all steps. A step that would pass it is skipped. */
  maxCostCents: z.number().min(0).max(100_000).optional(),
  delaySeconds: z.number().int().min(0).max(3600).optional(),
});
export type WaterfallConfig = z.infer<typeof waterfallConfigSchema>;

/** Email, url, date and json arrive from the model as text and are checked and converted before they are written (ai-output-coerce.ts). */
export const AI_OUTPUT_TYPES = ["text", "number", "boolean", "email", "url", "date", "json"] as const;
export const aiConfigSchema = z.strictObject({
  /** Instruction with {{column}} tokens. The cell values are sent separately, fenced as untrusted data. */
  prompt: z.string().trim().min(1).max(8000),
  outputs: z
    .array(z.strictObject({ key: z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), type: z.enum(AI_OUTPUT_TYPES), description: z.string().max(300).optional() }))
    .min(1)
    .max(12),
  /** Output field key to the ai_output column that receives it. */
  outputColumns: z.record(z.string(), columnKey),
  delaySeconds: z.number().int().min(0).max(3600).optional(),
});
export type AiConfig = z.infer<typeof aiConfigSchema>;

export const outputColumnConfigSchema = z.strictObject({
  sourceColumnKey: columnKey,
  outputKey: z.string().min(1).max(60),
  valueType: z.string().max(20),
});

const valueType = z.enum(["text", "email", "url", "number", "boolean", "json", "domain"]);

/** A request template for one action of the generic HTTP adapter. Tokens are `{{inputKey}}`. */
export const httpActionSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  method: z.enum(["GET", "POST"]).default("GET"),
  /** Appended to the provider's base URL. Tokens are percent-encoded. */
  path: z.string().regex(/^\/[A-Za-z0-9._~\-/{}]*$/).max(200),
  query: z.record(z.string().regex(QUERY_PARAM_NAME), z.string().max(200)).default({}),
  /** JSON body. String leaves may hold tokens; a leaf that is exactly one token keeps the input's own type. */
  body: z.record(z.string(), z.unknown()).optional(),
  inputs: z.array(z.strictObject({ key: z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/), name: z.string().min(1).max(80), type: valueType, required: z.boolean().default(true) })).min(1).max(10),
  /** Output key to a dotted path in the JSON response (`data.person.email`, `items.0.id`). */
  outputs: z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/), z.string().min(1).max(200)),
  primaryOutput: z.string().min(1).max(40),
  costCents: z.number().min(0).max(10_000).default(0),
});

export const httpProviderConfigSchema = z.strictObject({
  adapter: z.literal("http"),
  auth: z
    .strictObject({
      type: z.enum(["bearer", "header", "query", "none"]),
      /** Header or query parameter name for `header` and `query`. */
      name: z.string().optional(),
    })
    .default({ type: "bearer" })
    .superRefine((auth, ctx) => {
      if (auth.type === "header" && !(auth.name && HEADER_NAME.test(auth.name))) ctx.addIssue({ code: "custom", message: "auth.name must be a header name" });
      if (auth.type === "query" && !(auth.name && QUERY_PARAM_NAME.test(auth.name))) ctx.addIssue({ code: "custom", message: "auth.name must be a query parameter name" });
    }),
  actions: z.record(actionKey, httpActionSchema).refine((a) => Object.keys(a).length >= 1 && Object.keys(a).length <= 20, "Define 1 to 20 actions"),
});
export type HttpProviderConfig = z.infer<typeof httpProviderConfigSchema>;
export type HttpAction = z.infer<typeof httpActionSchema>;

export const simpleAdapterConfigSchema = z.strictObject({ adapter: z.string().refine((key) => SIMPLE_ADAPTER_KEYS.includes(key), "Unknown adapter") });

export function httpActionSpecs(config: HttpProviderConfig): ActionSpec[] {
  return Object.entries(config.actions).map(([key, action]) => ({
    key,
    name: action.name,
    inputs: action.inputs,
    outputs: Object.keys(action.outputs).map((k) => ({ key: k, name: k, type: "text" as const })),
    primaryOutput: action.primaryOutput,
    defaultCostCents: action.costCents,
  }));
}

/** Rejects an action whose primary output or token references do not exist. */
export function checkHttpConfig(config: HttpProviderConfig): string | null {
  for (const [key, action] of Object.entries(config.actions)) {
    if (!(action.primaryOutput in action.outputs)) return `Action ${key}: primaryOutput must be one of its outputs.`;
    const inputKeys = new Set(action.inputs.map((i) => normalizeKey(i.key)));
    const text = JSON.stringify([action.path, action.query, action.body ?? null]);
    for (const m of text.matchAll(TOKEN)) {
      if (!inputKeys.has(normalizeKey(m[1]))) return `Action ${key}: token {{${m[1]}}} is not one of its inputs.`;
    }
  }
  return null;
}
