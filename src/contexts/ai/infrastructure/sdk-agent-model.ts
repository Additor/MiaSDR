import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, generateText, stepCountIs, streamText, tool, type LanguageModel as SdkModel, type ModelMessage, type ToolSet } from "ai";
import type { AiConnectionSpec } from "@/contexts/integrations/domain/ai-connections";
import type { AgentChatRequest, AgentChatResult, AgentMessage, AgentModel, AgentStepRequest, AgentStepResult, AgentTool } from "../application/agent-ports";
import { AiError } from "../domain/ai-error";
import type { AiUsage } from "../domain/generation";

/**
 * Agent steps through the AI SDK. One call is one model answer and the tools it runs: the caller stores the messages and
 * asks for the next step, so a long run never holds a job tick and a restart costs no repeated call. The SDK retries
 * nothing, because the job owns retries. Keys and message bodies are never logged or put into an error.
 */

interface SdkAgentOptions {
  sdkModel: SdkModel;
  provider: string;
  model: string;
  label: string;
  /** Marks stable system text cacheable, on the providers that ask for a mark. */
  cacheProvider?: "anthropic" | "openrouter";
}

const STOP: Record<string, AgentStepResult["stop"]> = { stop: "end", "tool-calls": "tools", length: "max_tokens", "content-filter": "refusal" };

function usageOf(result: Pick<Awaited<ReturnType<typeof generateText>>, "usage" | "providerMetadata">): AiUsage {
  const { usage, providerMetadata } = result;
  const details = usage.inputTokenDetails;
  const cost = (providerMetadata?.openrouter as { usage?: { cost?: unknown } } | undefined)?.usage?.cost;
  return {
    // The SDK's total holds the cached tokens too. This record keeps them apart, as the other adapters do.
    inputTokens: details.noCacheTokens ?? usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: details.cacheReadTokens ?? 0,
    cacheWriteTokens: details.cacheWriteTokens ?? 0,
    ...(typeof cost === "number" ? { costUsd: cost } : {}),
  };
}

function toolSet(tools: readonly AgentTool<never>[]): ToolSet {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: t.input as never,
        execute: (input: never, options: { abortSignal?: AbortSignal }) => t.execute(input, options.abortSignal),
      }),
    ]),
  ) as ToolSet;
}

export class SdkAgentModel implements AgentModel {
  readonly provider: string;
  readonly model: string;
  private readonly sdkModel: SdkModel;
  private readonly label: string;
  private readonly cacheProvider?: "anthropic" | "openrouter";

  constructor(options: SdkAgentOptions) {
    this.sdkModel = options.sdkModel;
    this.provider = options.provider;
    this.model = options.model;
    this.label = options.label;
    this.cacheProvider = options.cacheProvider;
  }

  async step(request: AgentStepRequest): Promise<AgentStepResult> {
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: this.sdkModel,
        instructions: request.system.map((segment) => ({
          role: "system" as const,
          content: segment.text,
          ...(this.cacheProvider ? { providerOptions: { [this.cacheProvider]: { cacheControl: { type: "ephemeral" } } } } : {}),
        })),
        messages: request.messages as unknown as ModelMessage[],
        tools: toolSet(request.tools),
        ...(request.activeTools ? { activeTools: [...request.activeTools] } : {}),
        maxOutputTokens: request.maxTokens,
        maxRetries: 0,
        timeout: { stepMs: request.timeoutMs },
      });
    } catch (error) {
      throw this.failure(error);
    }
    const content = result.content as ReadonlyArray<{ type: string; toolCallId?: string }>;
    const failedCalls = new Set(content.filter((part) => part.type === "tool-error").map((part) => part.toolCallId));
    return {
      messages: [...request.messages, ...(result.response.messages as unknown as AgentMessage[])],
      toolCalls: result.toolCalls.map((call) => ({ name: call.toolName, failed: failedCalls.has(call.toolCallId) })),
      stop: STOP[result.finishReason] ?? "other",
      usage: usageOf(result),
    };
  }

  async chat(request: AgentChatRequest): Promise<AgentChatResult> {
    const usage: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    // The SDK's own record of the finished steps: the loop below reads the stream behind the SDK, so its sum can lag a step.
    const spent = (steps: ReadonlyArray<Pick<Awaited<ReturnType<typeof generateText>>, "usage" | "providerMetadata">>) =>
      steps.reduce((sum, step) => {
        const counted = usageOf(step);
        return sum + counted.inputTokens + (counted.cacheWriteTokens ?? 0) + counted.outputTokens;
      }, 0);
    // Near the end of the steps or the tokens, the model answers with what it read.
    const answerNow = (stepNumber: number, used: number) => stepNumber >= request.maxSteps - 1 || used >= request.turnTokens * 0.8;
    let text = "";
    let steps = 0;
    let finish: string | undefined;
    let failed: unknown;
    let aborted = false;
    const result = streamText({
      model: this.sdkModel,
      instructions: request.system.map((segment) => ({
        role: "system" as const,
        content: segment.text,
        ...(this.cacheProvider ? { providerOptions: { [this.cacheProvider]: { cacheControl: { type: "ephemeral" } } } } : {}),
      })),
      messages: request.messages as ModelMessage[],
      tools: toolSet(request.tools),
      maxOutputTokens: request.maxTokens,
      maxRetries: 0,
      abortSignal: request.signal,
      timeout: { totalMs: request.timeoutMs },
      stopWhen: [stepCountIs(request.maxSteps), ({ steps }) => spent(steps) >= request.turnTokens],
      prepareStep: ({ stepNumber, steps }) => (answerNow(stepNumber, spent(steps)) ? { activeTools: [] } : undefined),
    });
    try {
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          text += part.text;
          request.onText(part.text);
        } else if (part.type === "tool-result" || part.type === "tool-error") {
          request.onToolCall({ id: part.toolCallId, name: part.toolName, failed: part.type === "tool-error" });
        } else if (part.type === "finish-step") {
          steps += 1;
          finish = part.finishReason;
          const step = usageOf({ usage: part.usage, providerMetadata: part.providerMetadata } as never);
          usage.inputTokens += step.inputTokens;
          usage.outputTokens += step.outputTokens;
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (step.cacheReadTokens ?? 0);
          usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (step.cacheWriteTokens ?? 0);
          if (step.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + step.costUsd;
          request.onStepUsage(step);
        } else if (part.type === "abort") aborted = true;
        else if (part.type === "error") failed = part.error;
      }
    } catch (error) {
      if (request.signal.aborted) aborted = true;
      else failed = error;
    }
    if (aborted && request.signal.aborted) return { text, stop: "stopped", usage, steps };
    // Nothing reached the person, so the turn has nothing to keep and the reason is the provider's.
    if ((failed !== undefined || aborted) && text === "") throw this.failure(failed ?? Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    if (failed !== undefined || aborted) return { text, stop: "other", usage, steps };
    // A step that ended on tool calls means the steps or the tokens ran out first.
    const stop = STOP[finish ?? ""] ?? "other";
    return { text, stop: stop === "tools" ? "limit" : stop, usage, steps };
  }

  private failure(error: unknown): AiError {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return new AiError("The AI request timed out.", "transient");
    if (APICallError.isInstance(error)) {
      const status = error.statusCode ?? 0;
      if (status === 401 || status === 403) return new AiError(`${this.label} rejected the API key. Replace it in Settings, Integrations.`, "permanent");
      if (status === 402) return new AiError(`${this.label} reports a billing problem on this account.`, "permanent");
      if (status === 408 || status === 409 || status === 429 || status >= 500 || status === 0) return new AiError(`The AI service is unavailable (status ${status}).`, "transient");
      // A model without tool support answers here. The reason names it, and the person can pick another model.
      return new AiError(`${this.label} rejected the request (status ${status}): ${error.message.slice(0, 300)}`, "permanent");
    }
    return new AiError("Could not reach the AI service.", "transient");
  }
}

/** The SDK client for one connection. The keys and models are the ones Integrations already holds. */
export function buildAgentModel(spec: AiConnectionSpec, credentials: { apiKey: string; model: string }): AgentModel {
  const common = { provider: spec.key, model: credentials.model, label: spec.label };
  if (spec.protocol === "anthropic-messages") {
    // The SDK adds `/v1` only for Anthropic's own host, and the gateway's Messages endpoint sits under it too.
    const sdkModel = createAnthropic({ apiKey: credentials.apiKey, baseURL: `${spec.baseUrl}/v1` })(credentials.model);
    return new SdkAgentModel({ ...common, sdkModel, cacheProvider: "anthropic" });
  }
  const sdkModel = createOpenRouter({ apiKey: credentials.apiKey, baseURL: spec.baseUrl, headers: { "x-openrouter-title": "MiaSDR" } })(credentials.model, { usage: { include: true } }) as SdkModel;
  return new SdkAgentModel({ ...common, sdkModel, ...(credentials.model.startsWith("anthropic/") ? { cacheProvider: "openrouter" as const } : {}) });
}
