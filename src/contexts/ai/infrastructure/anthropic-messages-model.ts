import Anthropic from "@anthropic-ai/sdk";
import type { LanguageModel } from "../application/ports";
import { AiError } from "../domain/ai-error";
import type { GenerateRequest, GenerateResult, ModelCapabilities, StopReason } from "../domain/generation";

/**
 * The Anthropic Messages API through the official SDK. One adapter serves Anthropic itself and Vercel AI Gateway, whose
 * Anthropic Messages endpoint implements the same specification at another base URL. Structured outputs go in
 * `output_config.format`, stable system text gets `cache_control`, and the SDK retries 429 and 5xx with backoff.
 * Keys and message bodies are never logged or put into an error.
 */

export interface AnthropicMessagesOptions {
  apiKey: string;
  model: string;
  /** Connection key and label, for the model record and the error texts. */
  provider?: string;
  label?: string;
  baseURL?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Retries after the first try, for 408, 409, 429 and 5xx only. */
  maxRetries?: number;
}

const STOP: Record<string, StopReason> = { end_turn: "end", stop_sequence: "end", max_tokens: "max_tokens", refusal: "refusal" };

export class AnthropicMessagesModel implements LanguageModel {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities = { jsonSchema: "native", promptCache: "explicit", reportsCost: false };
  private readonly label: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicMessagesOptions) {
    this.provider = options.provider ?? "anthropic";
    this.label = options.label ?? "Anthropic";
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      fetch: options.fetch,
      timeout: options.timeoutMs ?? 45_000,
      maxRetries: options.maxRetries ?? 3,
    });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxTokens,
          system: request.system.map((segment) => ({ type: "text" as const, text: segment.text, ...(segment.cacheable ? { cache_control: { type: "ephemeral" as const } } : {}) })),
          messages: request.messages,
          ...(request.output.kind === "json" ? { output_config: { format: { type: "json_schema" as const, schema: request.output.schema } } } : {}),
        },
        { signal: request.signal },
      );
    } catch (error) {
      throw this.failure(error);
    }
    const text = message.content.find((block): block is Anthropic.TextBlock => block.type === "text")?.text ?? "";
    const usage = message.usage;
    return {
      text,
      stop: (message.stop_reason && STOP[message.stop_reason]) || "other",
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
      requestId: (message as { _request_id?: string | null })._request_id ?? undefined,
    };
  }

  private failure(error: unknown): AiError {
    if (error instanceof Anthropic.APIConnectionTimeoutError) return new AiError("The AI request timed out.", "transient");
    if (error instanceof Anthropic.APIUserAbortError) return new AiError("The AI request was cancelled.", "transient");
    if (error instanceof Anthropic.APIConnectionError) return new AiError("Could not reach the AI service.", "transient");
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return new AiError(`${this.label} rejected the API key. Replace it in Settings, Integrations.`, "permanent");
    }
    if (error instanceof Anthropic.APIError) {
      const status = error.status ?? 0;
      if (status === 402) return new AiError(`${this.label} reports a billing problem on this account.`, "permanent");
      if (status === 408 || status === 409 || status === 429 || status >= 500) return new AiError(`The AI service is unavailable (status ${status}).`, "transient");
      const detail = (error.error as { error?: { message?: string } } | undefined)?.error?.message?.slice(0, 300) ?? "";
      return new AiError(`${this.label} rejected the request (status ${status})${detail ? `: ${detail}` : ""}.`, "permanent");
    }
    return new AiError("Could not reach the AI service.", "transient");
  }
}
