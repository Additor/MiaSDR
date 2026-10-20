import type { CredentialVerifier } from "@/contexts/integrations/application/credential-verifier";
import { createCredentialVerifier, createKeyCheck, headerSafe, type VerifierOptions } from "@/contexts/integrations/infrastructure/credential-verifier";
import { apollo } from "./apollo";
import { hunter } from "./hunter";
import type { VendorDefinition } from "./vendor-kit";

/** Every vendor with a native adapter. A catalog entry is `available` exactly when it has a definition here. */
export const VENDORS: readonly VendorDefinition[] = [hunter, apollo];

export const vendorFor = (key: string): VendorDefinition | undefined => VENDORS.find((v) => v.key === key);

/** Checks enrichment vendor keys through their definitions and hands every other provider to the shared verifier. */
export function createEnrichmentVerifier(options: VerifierOptions = {}): CredentialVerifier {
  const base = createCredentialVerifier(options);
  return {
    async verify(providerKey, values, opts) {
      const vendor = vendorFor(providerKey);
      if (!vendor) return base.verify(providerKey, values, opts);
      if (options.skip?.(providerKey)) return { ok: true, verified: false };
      const apiKey = values.apiKey;
      if (!apiKey || !headerSafe(apiKey)) return { ok: false, reason: "rejected" };
      return vendor.checkKey(apiKey, createKeyCheck({ fetch: options.fetch, timeoutMs: options.timeoutMs, signal: opts?.signal }));
    },
  };
}
