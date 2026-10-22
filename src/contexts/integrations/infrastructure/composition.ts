import { env } from "@/shared/env";
import type { AiModelDeps } from "../application/ai-model";
import type { CredentialCipher, IntegrationDeps } from "../application/integration-management";
import { aiConnection } from "../domain/ai-connections";
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
