import { and, eq } from "drizzle-orm";
import { aiConnection, effectiveAiModel, pickActiveAiConnection } from "@/contexts/integrations/domain/ai-connections";
import { credentialCipher } from "@/contexts/integrations/infrastructure/credential-cipher";
import { db } from "@/platform/db/client";
import { integrationAccounts, integrationCredentials } from "@/platform/db/schema";
import type { LanguageModel, LanguageModelResolver } from "../application/ports";
import { buildLanguageModel } from "./model-factory";

/**
 * The organization's active AI connection with its key, decrypted for this call only, and the model it runs. No key,
 * or a gateway connection with no model picked yet, means null: AI is not configured.
 */
export function createModelResolver(options: { envModel?: string; fetch?: typeof fetch } = {}): LanguageModelResolver {
  return {
    async forOrganization(organizationId): Promise<LanguageModel | null> {
      const rows = await db
        .select({ key: integrationAccounts.key, payload: integrationCredentials.encryptedPayload, config: integrationAccounts.config })
        .from(integrationAccounts)
        .innerJoin(integrationCredentials, eq(integrationCredentials.accountId, integrationAccounts.id))
        .where(and(eq(integrationAccounts.organizationId, organizationId), eq(integrationAccounts.kind, "ai"), eq(integrationAccounts.enabled, true)));
      const active = pickActiveAiConnection(rows.map((r) => ({ ...r, primary: r.config?.primary === true })));
      const spec = active && aiConnection(active.key);
      if (!active || !spec) return null;
      const model = effectiveAiModel(spec, typeof active.config?.model === "string" ? active.config.model : null, options.envModel);
      if (!model) return null;
      try {
        const { apiKey } = JSON.parse(credentialCipher.decrypt(active.payload)) as { apiKey?: string };
        if (!apiKey) return null;
        return buildLanguageModel(spec, { apiKey, model }, { fetch: options.fetch });
      } catch {
        console.error(`The stored ${spec.label} credential could not be read. Save the key again in Settings, Integrations.`);
        return null;
      }
    },
  };
}
