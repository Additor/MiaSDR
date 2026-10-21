import type { CredentialVerifier } from "@/platform/credentials/verify";
import { createKeyCheck, headerSafe, standardStatus } from "@/platform/credentials/key-check";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
// Same version header as the Anthropic provider in the conversations context.
const ANTHROPIC_VERSION = "2023-06-01";

export interface VerifierOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** True for providers that must make no network call (fake modes). */
  skip?: (providerKey: string) => boolean;
}

/**
 * Verifies the Anthropic key with one fixed GET. The key travels in a header, never in a URL. Enrichment vendors check
 * their keys in the grid context, which owns them.
 */
export function createCredentialVerifier(options: VerifierOptions = {}): CredentialVerifier {
  return {
    async verify(providerKey, values, opts) {
      if (options.skip?.(providerKey)) return { ok: true, verified: false };
      const apiKey = values.apiKey;
      if (providerKey !== "anthropic") return { ok: true, verified: false };
      if (!apiKey || !headerSafe(apiKey)) return { ok: false, reason: "rejected" };
      const check = createKeyCheck({ fetch: options.fetch, timeoutMs: options.timeoutMs, signal: opts?.signal });
      return check({ url: ANTHROPIC_MODELS_URL, headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" }, map: standardStatus });
    },
  };
}
