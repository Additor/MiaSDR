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
  /** The string goes back to the model. A throw also goes back to it, as the failed call's result. */
  execute(input: I): Promise<string>;
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

/** One configured model that can call tools. The caller stores the messages between steps, so a run survives a restart. */
export interface AgentModel {
  readonly provider: string;
  readonly model: string;
  step(request: AgentStepRequest): Promise<AgentStepResult>;
}

/** The organization's configured model for agent work. Null means AI is not configured there. */
export interface AgentModelResolver {
  forOrganization(organizationId: string): Promise<AgentModel | null>;
  status(organizationId: string): Promise<AiStatus>;
}
