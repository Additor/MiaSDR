import { env } from "@/shared/env";
import type { AgentModelResolver } from "../application/agent-ports";
import type { LanguageModelResolver } from "../application/ports";
import { createAgentModelResolver, createModelResolver } from "./model-resolver";

/** AI_PROVIDER=fake (demos and tests): each feature answers with its own fake and asks no model. */
export const aiFakeMode = (): boolean => env().AI_PROVIDER === "fake";

/** The organization's configured language model, for every AI feature. */
export const languageModels: LanguageModelResolver = createModelResolver();

/** The same connection as a model that can call tools, for agent work. */
export const agentModels: AgentModelResolver = createAgentModelResolver();
