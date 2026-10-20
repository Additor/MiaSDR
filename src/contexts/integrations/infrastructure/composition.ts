import { env } from "@/shared/env";
import type { AiModelDeps } from "../application/ai-model";
import type { CredentialCipher, IntegrationDeps } from "../application/integration-management";
import { createModelCatalog } from "./anthropic-model-catalog";
import { credentialCipher } from "./credential-cipher";
import { createCredentialVerifier } from "./credential-verifier";
import { drizzleAiModelStore } from "./drizzle-ai-model-store";
import { drizzleIntegrationStore } from "./drizzle-integration-store";

const cipher: CredentialCipher = { encrypt: credentialCipher.encrypt };

/** Wires integration management: the store, the encrypting cipher and the live credential check. */
export function integrationDeps(): IntegrationDeps {
  // AI_PROVIDER=fake (demos, tests) makes no Anthropic call, the same switch the AI composition uses.
  const verifier = createCredentialVerifier({ skip: (key) => key === "anthropic" && env().AI_PROVIDER === "fake" });
  return { integrations: drizzleIntegrationStore, cipher, verifier };
}

/** Wires the AI model picker: the store, the Anthropic model catalog and the credential decryptor. */
export function aiModelDeps(): AiModelDeps {
  return {
    store: drizzleAiModelStore,
    catalog: createModelCatalog(),
    decrypt: credentialCipher.decrypt,
    skipLive: env().AI_PROVIDER === "fake",
    envModel: env().AI_MODEL,
  };
}
