/**
 * The AI providers an organization can connect. Integrations stores the key and the chosen model; the ai context
 * reads this list to build a model client. Two protocols cover all three: Anthropic and Vercel AI Gateway speak the
 * Anthropic Messages API (the gateway at its own base URL), OpenRouter speaks OpenAI Chat Completions.
 */

export type AiConnectionKey = "anthropic" | "vercel-ai-gateway" | "openrouter";
export type AiProtocol = "anthropic-messages" | "openai-chat";

export interface AiConnectionSpec {
  key: AiConnectionKey;
  label: string;
  description: string;
  protocol: AiProtocol;
  /** Base URL the protocol's client is pointed at. */
  baseUrl: string;
  /** One authenticated GET that answers 401 or 403 for a bad key. */
  keyCheck: { url: string; auth: "anthropic" | "bearer" };
  /** The model list. `anthropic` pages with the saved key; `public` lists need no key. */
  models: { url: string; auth: "anthropic" | "public"; keep?: (model: { id: string; type?: string }) => boolean };
  /** The model used when the organization picks none. Null means it must pick one. */
  defaultModel: string | null;
  /** `AI_MODEL` from the environment overrides `defaultModel`. */
  envModelApplies: boolean;
  /**
   * Model ids a save accepts when the live list cannot be reached. The live list is the source of truth; this list only
   * keeps a save possible during an outage, for ids that were valid when it was written. Empty means no save then.
   */
  fallbackModels: readonly string[];
}

/** The model the code uses when neither the organization nor `AI_MODEL` names one, on a direct Anthropic connection. */
export const DEFAULT_AI_MODEL = "claude-sonnet-5-5";

/** Anthropic models accepted when Anthropic's live list cannot be reached. */
export const KNOWN_AI_MODELS: readonly string[] = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-opus-5", "claude-sonnet-5"];

export const AI_CONNECTIONS: readonly AiConnectionSpec[] = [
  {
    key: "anthropic",
    label: "Anthropic",
    description: "Your Anthropic API key, for reply classification, drafts and AI columns.",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    keyCheck: { url: "https://api.anthropic.com/v1/models?limit=1", auth: "anthropic" },
    models: { url: "https://api.anthropic.com/v1/models", auth: "anthropic" },
    defaultModel: DEFAULT_AI_MODEL,
    envModelApplies: true,
    fallbackModels: KNOWN_AI_MODELS,
  },
  {
    key: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    description: "An AI Gateway API key. Claude models run through the gateway's Anthropic Messages endpoint.",
    protocol: "anthropic-messages",
    baseUrl: "https://ai-gateway.vercel.sh",
    keyCheck: { url: "https://ai-gateway.vercel.sh/v1/credits", auth: "bearer" },
    // The Messages endpoint is the Anthropic API, so only Anthropic's models are offered through it.
    models: { url: "https://ai-gateway.vercel.sh/v1/models", auth: "public", keep: (m) => m.type === "language" && m.id.startsWith("anthropic/") },
    defaultModel: null,
    envModelApplies: false,
    fallbackModels: [],
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    description: "An OpenRouter API key. Any model OpenRouter lists with structured output support.",
    protocol: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    keyCheck: { url: "https://openrouter.ai/api/v1/key", auth: "bearer" },
    // Every AI feature asks for JSON that fits a schema, so only models that support it are offered.
    models: { url: "https://openrouter.ai/api/v1/models?supported_parameters=structured_outputs", auth: "public" },
    defaultModel: null,
    envModelApplies: false,
    fallbackModels: [],
  },
];

export const aiConnection = (key: string): AiConnectionSpec | undefined => AI_CONNECTIONS.find((c) => c.key === key);

/** The model a connection runs: the organization's pick, else `AI_MODEL` where it applies, else the default. Null when none applies. */
export function effectiveAiModel(spec: AiConnectionSpec, chosen: string | null, envModel?: string): string | null {
  if (chosen) return chosen;
  return (spec.envModelApplies && envModel) || spec.defaultModel;
}

/**
 * The connection AI runs on when an organization saved several: the one marked primary, else the one in the order of
 * `AI_CONNECTIONS` (so an organization that only ever saved an Anthropic key keeps using it).
 */
export function pickActiveAiConnection<T extends { key: string; primary: boolean }>(accounts: readonly T[]): T | null {
  const known = accounts.filter((a) => aiConnection(a.key));
  const primary = known.find((a) => a.primary);
  if (primary) return primary;
  for (const spec of AI_CONNECTIONS) {
    const match = known.find((a) => a.key === spec.key);
    if (match) return match;
  }
  return null;
}
