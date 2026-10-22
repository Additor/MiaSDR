import type { LanguageModel } from "../application/ports";
import { AiError } from "../domain/ai-error";
import type { GenerateRequest, GenerateResult, ModelCapabilities, StopReason } from "../domain/generation";

/**
 * OpenAI Chat Completions over fetch, as OpenRouter documents it: POST {baseUrl}/chat/completions with a bearer key.
 * Structured outputs go in `response_format` (`json_schema`, strict), and `provider.require_parameters` routes only to
 * endpoints that support them. Support is per endpoint and strict is a hint on some, so callers validate the answer
 * again. Anthropic models get `cache_control` on stable system text. Keys and message bodies are never logged.
 */

export interface OpenAiChatOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  provider?: string;
  label?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Retries after the first try, for 429 and 5xx only. */
  maxRetries?: number;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;
const STOP: Record<string, StopReason> = { stop: "end", length: "max_tokens", content_filter: "refusal" };

interface ChatResponse {
  id?: string;
  error?: { message?: string; code?: number | string };
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    cache_write_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

export class OpenAiChatModel implements LanguageModel {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities = { jsonSchema: "best_effort", promptCache: "explicit", reportsCost: true };
  private readonly label: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: OpenAiChatOptions) {
    this.provider = options.provider ?? "openrouter";
    this.label = options.label ?? "OpenRouter";
    this.model = options.model;
    this.url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    // OpenRouter passes `cache_control` through to Anthropic models only; other providers cache on their own or not at all.
    const marksCache = this.model.startsWith("anthropic/");
    const body = JSON.stringify({
      model: this.model,
      max_tokens: request.maxTokens,
      messages: [
        { role: "system", content: request.system.map((s) => ({ type: "text", text: s.text, ...(marksCache && s.cacheable ? { cache_control: { type: "ephemeral" } } : {}) })) },
        ...request.messages,
      ],
      ...(request.output.kind === "json"
        ? { response_format: { type: "json_schema", json_schema: { name: request.output.name, strict: true, schema: request.output.schema } }, provider: { require_parameters: true } }
        : {}),
    });

    let lastStatus = 0;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "x-openrouter-title": "MiaSDR" },
          body,
          signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new AiError(timedOut ? "The AI request timed out." : "Could not reach the AI service.", "transient");
      }
      if (response.ok) return this.read(response);
      lastStatus = response.status;
      if (RETRYABLE(response.status) && attempt < this.maxRetries) {
        await response.body?.cancel().catch(() => undefined);
        await this.sleep(this.backoff(attempt, response.headers.get("retry-after")));
        continue;
      }
      throw await this.failure(response);
    }
    throw new AiError(`The AI service kept failing (status ${lastStatus}).`, "transient");
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const asked = retryAfter ? Number(retryAfter) * 1000 : NaN;
    const own = 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
    return Math.min(30_000, Number.isFinite(asked) && asked > 0 ? asked : own);
  }

  private async failure(response: Response): Promise<AiError> {
    const status = response.status;
    let detail = "";
    try {
      detail = ((await response.json()) as ChatResponse).error?.message?.slice(0, 300) ?? "";
    } catch {
      // The status alone is enough.
    }
    if (status === 401 || status === 403) return new AiError(`${this.label} rejected the API key. Replace it in Settings, Integrations.`, "permanent");
    if (status === 402) return new AiError(`${this.label} reports that the account has no credits left.`, "permanent");
    if (RETRYABLE(status)) return new AiError(`The AI service is unavailable (status ${status}).`, "transient");
    return new AiError(`${this.label} rejected the request (status ${status})${detail ? `: ${detail}` : ""}.`, "permanent");
  }

  private async read(response: Response): Promise<GenerateResult> {
    let json: ChatResponse;
    try {
      json = (await response.json()) as ChatResponse;
    } catch {
      throw new AiError("The AI service sent a response that is not JSON.", "transient");
    }
    const choice = json.choices?.[0];
    // A provider error can arrive with status 200, at the top level or as the finish reason.
    if (json.error || !choice || choice.finish_reason === "error") throw new AiError(`The AI service failed to answer${json.error?.message ? `: ${json.error.message.slice(0, 300)}` : "."}`, "transient");
    const usage = json.usage ?? {};
    return {
      text: choice.message?.content ?? "",
      stop: (choice.finish_reason && STOP[choice.finish_reason]) || "other",
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: usage.prompt_tokens_details?.cache_write_tokens ?? usage.cache_write_tokens ?? 0,
        ...(typeof usage.cost === "number" ? { costUsd: usage.cost } : {}),
      },
      requestId: json.id,
    };
  }
}
