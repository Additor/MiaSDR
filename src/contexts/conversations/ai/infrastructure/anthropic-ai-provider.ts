import { randomBytes } from "node:crypto";
import { answerJsonSchema, answerSchema, classificationJsonSchema, classificationSchema, DRAFT_JSON_SCHEMA, draftSchema, LINKEDIN_DRAFT_JSON_SCHEMA, linkedinDraftSchema, type AnswerInput, type AnswerOutput, type ClassifyInput, type DraftInput } from "../domain/ai-contract";
import { buildAnswerPrompt, buildClassifyPrompt, buildDraftPrompt } from "../domain/prompts";
import { AiError, type AiProvider } from "../application/ai-ports";

/**
 * Anthropic Messages API over fetch. Request shape verified 2026-10-14 against
 * platform.claude.com/docs/en/api/messages and .../build-with-claude/structured-outputs:
 * POST /v1/messages, headers x-api-key, anthropic-version 2023-06-01, content-type application/json;
 * body model, max_tokens, system, messages, output_config.format {type: "json_schema", schema}.
 * Claude Sonnet 5.5 rejects forced tool_choice, so structured outputs carry the closed schema.
 * The answer is JSON text in the first `text` block. Keys and message bodies are never logged.
 */

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Retries after the first try, for 429 and 5xx only. */
  maxRetries?: number;
  baseUrl?: string;
}

interface Completion {
  data: unknown;
  usage: Record<string, number>;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

export class AnthropicAiProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly url: string;

  constructor(options: AnthropicOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model || DEFAULT_ANTHROPIC_MODEL;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.url = options.baseUrl ?? API_URL;
  }

  async classify(input: ClassifyInput) {
    const keys = input.taxonomy.map((t) => t.key);
    const prompt = buildClassifyPrompt(input, randomBytes(6).toString("hex"));
    const { data, usage } = await this.complete(prompt, classificationJsonSchema(keys), 4000);
    const parsed = classificationSchema(keys).safeParse(data);
    if (!parsed.success) throw new AiError("The model answered outside the allowed categories.", "transient", "shape");
    return { output: parsed.data, usage };
  }

  async draft(input: DraftInput) {
    const prompt = buildDraftPrompt(input, randomBytes(6).toString("hex"));
    const linkedin = input.channel === "linkedin";
    const { data, usage } = await this.complete(prompt, linkedin ? LINKEDIN_DRAFT_JSON_SCHEMA : DRAFT_JSON_SCHEMA, 8000);
    const parsed = linkedin ? linkedinDraftSchema.safeParse(data) : draftSchema.safeParse(data);
    if (!parsed.success) throw new AiError("The model returned a draft in an unexpected shape.", "transient", "shape");
    return { output: { subject: parsed.data.subject ?? "", bodyText: parsed.data.bodyText }, usage };
  }

  async answer(input: AnswerInput) {
    const prompt = buildAnswerPrompt(input, randomBytes(6).toString("hex"));
    const { data, usage } = await this.complete(prompt, answerJsonSchema(input.outputs), 4000);
    const parsed = answerSchema(input.outputs).safeParse(data);
    if (!parsed.success) throw new AiError("The model answered with fields that were not requested.", "transient", "shape");
    return { output: parsed.data as AnswerOutput, usage };
  }

  private async complete(prompt: { system: string; user: string }, schema: object, maxTokens: number): Promise<Completion> {
    const body = JSON.stringify({
      model: this.model,
      max_tokens: maxTokens,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      output_config: { format: { type: "json_schema", schema } },
    });

    let lastStatus = 0;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "x-api-key": this.apiKey, "anthropic-version": API_VERSION, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new AiError(timedOut ? "The AI request timed out." : "Could not reach the AI service.", "transient");
      }

      if (response.ok) return this.read(response);

      lastStatus = response.status;
      if (RETRYABLE(response.status) && attempt < this.maxRetries) {
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
      const json = (await response.json()) as { error?: { message?: string } };
      detail = (json.error?.message ?? "").slice(0, 300);
    } catch {
      // The status alone is enough.
    }
    if (status === 401 || status === 403) return new AiError("Anthropic rejected the API key. Replace it in Settings, Integrations.", "permanent");
    if (status === 402) return new AiError("Anthropic reports a billing problem on this account.", "permanent");
    if (RETRYABLE(status)) return new AiError(`The AI service is unavailable (status ${status}).`, "transient");
    return new AiError(`Anthropic rejected the request (status ${status})${detail ? `: ${detail}` : ""}.`, "permanent");
  }

  private async read(response: Response): Promise<Completion> {
    let json: { content?: Array<{ type: string; text?: string }>; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    try {
      json = await response.json();
    } catch {
      throw new AiError("The AI service sent a response that is not JSON.", "transient");
    }
    if (json.stop_reason === "refusal") throw new AiError("The model declined to answer this message.", "permanent");
    if (json.stop_reason === "max_tokens") throw new AiError("The model's answer was cut off.", "transient");
    const textBlock = json.content?.find((b) => b.type === "text" && typeof b.text === "string");
    if (!textBlock?.text) throw new AiError("The model returned no text.", "transient");
    let data: unknown;
    try {
      data = JSON.parse(textBlock.text);
    } catch {
      throw new AiError("The model's answer was not valid JSON.", "transient", "shape");
    }
    return { data, usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 } };
  }
}
