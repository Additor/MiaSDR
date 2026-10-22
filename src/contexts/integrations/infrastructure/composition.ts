import { env } from "@/shared/env";
import { apiKeyOf, runningAi, type AiModelDeps } from "../application/ai-model";
import type { CredentialCipher, IntegrationDeps } from "../application/integration-management";
import { aiConnection, type AiConnectionSpec } from "../domain/ai-connections";
import { createModelCatalog } from "./ai-model-catalog";
import { credentialCipher } from "./credential-cipher";
import { createCredentialVerifier } from "./credential-verifier";
import { drizzleAiModelStore } from "./drizzle-ai-model-store";
import { drizzleIntegrationStore } from "./drizzle-integration-store";

const cipher: CredentialCipher = { encrypt: credentialCipher.encrypt };

/** Wires integration management: the store, the encrypting cipher and the live credential check. */
export function integrationDeps(): IntegrationDeps {
  // AI_PROVIDER=fake (demos, tests) makes no AI provider call, the same switch the ai context uses.
  const verifier = createCredentialVerifier({ skip: (key) => aiConnection(key) !== undefined && env().AI_PROVIDER === "fake" });
  return { integrations: drizzleIntegrationStore, cipher, verifier };
}

/** Wires the AI model picker: the store, the per-connection model catalog and the credential decryptor. */
export function aiModelDeps(): AiModelDeps {
  return {
    store: drizzleAiModelStore,
    catalog: createModelCatalog(),
    decrypt: credentialCipher.decrypt,
    skipLive: env().AI_PROVIDER === "fake",
    envModel: env().AI_MODEL,
  };
}

/**
 * The connection AI runs on for an organization and its model, the same answer the AI model card shows. `apiKey()`
 * decrypts the saved key only when called, so a caller that only asks whether AI is on never decrypts it.
 */
export async function runningAiConnection(organizationId: string): Promise<{ spec: AiConnectionSpec; model: string; apiKey(): string | null } | null> {
  const running = runningAi(await drizzleAiModelStore.listAi(organizationId), env().AI_MODEL);
  if (!running) return null;
  return { spec: running.spec, model: running.model, apiKey: () => apiKeyOf(() => credentialCipher.decrypt(running.account.encryptedPayload)) };
}
