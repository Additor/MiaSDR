import { aiStatus, runningAiConnection } from "@/contexts/integrations/infrastructure/composition";
import type { AgentModel, AgentModelResolver } from "../application/agent-ports";
import type { LanguageModel, LanguageModelResolver } from "../application/ports";
import { buildLanguageModel, type CallLimits } from "./model-factory";
import { buildAgentModel } from "./sdk-agent-model";

/** The running connection and its key, decrypted for this call only. No key, or a gateway connection with no model picked yet, means null: AI is not configured. */
async function runningCredentials(organizationId: string) {
  const running = await runningAiConnection(organizationId);
  if (!running) return null;
  const apiKey = running.apiKey();
  if (!apiKey) {
    console.error(`The stored ${running.spec.label} credential could not be read. Save the key again in Settings, Integrations.`);
    return null;
  }
  return { spec: running.spec, credentials: { apiKey, model: running.model } };
}

/** The organization's running AI connection and the model it runs. `limits` replaces the default timeout and retries. */
export function createModelResolver(limits: CallLimits = {}): LanguageModelResolver {
  return {
    async forOrganization(organizationId): Promise<LanguageModel | null> {
      const running = await runningCredentials(organizationId);
      return running && buildLanguageModel(running.spec, running.credentials, limits);
    },

    status: aiStatus,
  };
}

/** The same connection, through the client that can call tools. */
export function createAgentModelResolver(): AgentModelResolver {
  return {
    async forOrganization(organizationId): Promise<AgentModel | null> {
      const running = await runningCredentials(organizationId);
      return running && buildAgentModel(running.spec, running.credentials);
    },

    status: aiStatus,
  };
}
