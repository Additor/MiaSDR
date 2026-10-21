import type { CredentialVerifier } from "@/platform/credentials/verify";
import { createCredentialVerifier, type VerifierOptions } from "@/contexts/integrations/infrastructure/credential-verifier";
import { createKeyCheck, headerSafe } from "@/platform/credentials/key-check";
import { apollo } from "./apollo";
import { findymail } from "./findymail";
import { hunter } from "./hunter";
import { leadmagic } from "./leadmagic";
import { millionverifier } from "./millionverifier";
import { neverbounce } from "./neverbounce";
import { peopledatalabs } from "./peopledatalabs";
import { prospeo } from "./prospeo";
import type { VendorDefinition } from "./vendor-kit";
import { zerobounce } from "./zerobounce";

/** Every vendor with a native adapter. A catalog entry is `available` exactly when it has a definition here. */
export const VENDORS: readonly VendorDefinition[] = [hunter, apollo, zerobounce, millionverifier, neverbounce, findymail, prospeo, leadmagic, peopledatalabs];

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
