import type { AiConnectionSpec } from "@/contexts/integrations/domain/ai-connections";
import type { LanguageModel } from "../application/ports";
import { AnthropicMessagesModel } from "./anthropic-messages-model";
import { OpenAiChatModel } from "./openai-chat-model";

/** The client for one connection: the protocol picks the adapter, the spec supplies the base URL. */
export function buildLanguageModel(spec: AiConnectionSpec, credentials: { apiKey: string; model: string }, options: { fetch?: typeof fetch } = {}): LanguageModel {
  const common = { apiKey: credentials.apiKey, model: credentials.model, provider: spec.key, label: spec.label, fetch: options.fetch };
  if (spec.protocol === "anthropic-messages") return new AnthropicMessagesModel({ ...common, baseURL: spec.baseUrl });
  return new OpenAiChatModel({ ...common, baseUrl: spec.baseUrl });
}
