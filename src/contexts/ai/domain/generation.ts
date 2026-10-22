import type { AiTaskKey } from "./ai-tasks";

/** A JSON Schema object as the providers accept it: closed objects, no range or length keywords. */
export type JsonSchema = Record<string, unknown>;

/** One part of the system prompt. `cacheable` marks text that stays the same across requests, so a provider that caches prompts may cache up to it. */
export interface PromptSegment {
  text: string;
  cacheable?: boolean;
}

export type GenerateOutput = { kind: "text" } | { kind: "json"; name: string; schema: JsonSchema };

export interface GenerateRequest {
  task: AiTaskKey;
  system: PromptSegment[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  output: GenerateOutput;
  maxTokens: number;
  signal?: AbortSignal;
}

/** Why the model stopped, the same words for every provider. */
export type StopReason = "end" | "max_tokens" | "refusal" | "other";

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** What the provider reported the call cost, in US dollars. Absent when the provider does not report it. */
  costUsd?: number;
}

export interface GenerateResult {
  text: string;
  stop: StopReason;
  usage: AiUsage;
  /** The provider's id for the call, for support requests and the provider's own logs. */
  requestId?: string;
}

/** What an adapter guarantees, so a feature can tell what to expect before it asks. */
export interface ModelCapabilities {
  /** `native`: the provider enforces the schema. `best_effort`: it may answer outside it, and the caller's validation catches that. */
  jsonSchema: "native" | "best_effort";
  promptCache: "explicit" | "none";
  reportsCost: boolean;
}

/** Usage as the job records store it: numbers only, absent fields left out. */
export function usageRecord(usage: AiUsage): Record<string, number> {
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => typeof value === "number")) as Record<string, number>;
}
