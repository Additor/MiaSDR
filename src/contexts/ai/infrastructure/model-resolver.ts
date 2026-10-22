import { aiStatus, runningAiConnection } from "@/contexts/integrations/infrastructure/composition";
import type { LanguageModel, LanguageModelResolver } from "../application/ports";
import { buildLanguageModel } from "./model-factory";

/**
 * The organization's running AI connection with its key, decrypted for this call only, and the model it runs. No key,
 * or a gateway connection with no model picked yet, means null: AI is not configured.
 */
export function createModelResolver(options: { fetch?: typeof fetch } = {}): LanguageModelResolver {
  return {
    async forOrganization(organizationId): Promise<LanguageModel | null> {
      const running = await runningAiConnection(organizationId);
      if (!running) return null;
      const apiKey = running.apiKey();
      if (!apiKey) {
        console.error(`The stored ${running.spec.label} credential could not be read. Save the key again in Settings, Integrations.`);
        return null;
      }
      return buildLanguageModel(running.spec, { apiKey, model: running.model }, { fetch: options.fetch });
    },

    status: aiStatus,
  };
}
