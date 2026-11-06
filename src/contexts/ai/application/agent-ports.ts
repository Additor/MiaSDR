import type { z } from "zod";
import type { AiStatus } from "@/contexts/integrations/domain/ai-status";
import type { AiTaskKey } from "../domain/ai-tasks";
import type { AiUsage, PromptSegment } from "../domain/generation";

/** One message of a conversation with a model, as JSON. A feature stores and hands back the list without reading it. */
export type AgentMessage = Record<string, unknown>;

/** What a model may call. The feature decides what a tool can reach, so what a run can do is the list it passes. */
export interface AgentTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /**
   * The string goes back to the model. A throw also goes back to it, as the failed call's result. `signal` fires when the
   * step's time is up: the step waits for its tools, so a tool that waits on the network has to stop with it.
   */
  execute(input: I, signal?: AbortSignal): Promise<string>;
}

export interface AgentStepRequest {
  task: AiTaskKey;
  system: PromptSegment[];
  /** The conversation so far, oldest first. */
  messages: AgentMessage[];
  tools: readonly AgentTool<never>[];
  /** Limits this step to these tools. */
  activeTools?: readonly string[];
  maxTokens: number;
  /** Covers the model call and the tools it runs. */
  timeoutMs: number;
}

export interface AgentToolCall {
  name: string;
  failed: boolean;
}

export interface AgentStepResult {
  /** `messages` with this step's answer and tool results added. */
  messages: AgentMessage[];
  toolCalls: AgentToolCall[];
  /** Why the model stopped. A step that called tools ends with `tools`. */
  stop: "end" | "tools" | "max_tokens" | "refusal" | "other";
  usage: AiUsage;
}

export interface AgentChatRequest {
  task: AiTaskKey;
  system: PromptSegment[];
  /** The conversation so far as plain text turns, oldest first, ending with the person's question. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools: readonly AgentTool<never>[];
  /** The last step gets no tools, so the answer comes in it at the latest. */
  maxSteps: number;
  /** Output tokens per step. */
  maxTokens: number;
  /** The turn stops after the step that passes this many counted tokens. */
  turnTokens: number;
  /** The whole answer, its tools included. */
  timeoutMs: number;
  /** A person's Stop, or a deleted chat. The answer so far stays. */
  signal: AbortSignal;
  onText(delta: string): void;
  onToolCall(call: AgentToolCall & { id: string }): void;
  /** Each finished step's usage, as it ends: a turn that stops or fails later still counts the steps before. */
  onStepUsage(usage: AiUsage): void;
}

export interface AgentChatResult {
  text: string;
  /** `stopped` is the caller's signal; `limit` is the steps or tokens running out before the model ended. */
  stop: "end" | "max_tokens" | "refusal" | "limit" | "stopped" | "other";
  usage: AiUsage;
  steps: number;
}

/** One configured model that can call tools. The caller stores the messages between steps, so a run survives a restart. */
export interface AgentModel {
  readonly provider: string;
  readonly model: string;
  step(request: AgentStepRequest): Promise<AgentStepResult>;
  /** A streamed answer to a person, its tool steps run in one call. Throws an `AiError` when no answer could start. */
  chat(request: AgentChatRequest): Promise<AgentChatResult>;
}

/** The organization's configured model for agent work. Null means AI is not configured there. */
export interface AgentModelResolver {
  forOrganization(organizationId: string): Promise<AgentModel | null>;
  status(organizationId: string): Promise<AiStatus>;
}
