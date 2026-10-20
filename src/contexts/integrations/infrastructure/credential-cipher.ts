import { env } from "@/shared/env";
import { decryptCredential, encryptCredential, parseLegacyKeys } from "./credential-crypto";

export { envelopeVersion } from "./credential-crypto";

/**
 * The one place that turns INTEGRATION_CREDENTIALS_KEY into a cipher. Encrypt always uses the current key.
 * Decrypt picks the key by the envelope's key id from the current key plus INTEGRATION_CREDENTIALS_LEGACY_KEYS.
 */
export const credentialCipher = {
  encrypt: (plaintext: string): string => encryptCredential(plaintext, env().INTEGRATION_CREDENTIALS_KEY),
  decrypt: (envelope: string): string =>
    decryptCredential(envelope, env().INTEGRATION_CREDENTIALS_KEY, parseLegacyKeys(env().INTEGRATION_CREDENTIALS_LEGACY_KEYS)),
};
