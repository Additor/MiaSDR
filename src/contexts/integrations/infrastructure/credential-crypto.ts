import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for integration credentials: `v2:<keyId>:<iv>:<tag>:<ciphertext>`,
 * each binary part base64url. `keyId` is the first 8 hex characters of SHA-256 over the secret,
 * so a decrypt picks the right key from a list. The 32-byte key comes from the secret through
 * HKDF-SHA256, so any string of 32 or more characters works as input.
 *
 * The older `v1:<iv>:<tag>:<ciphertext>` envelope (no key id) still decrypts: every known key is tried.
 * `scripts/rotate-credentials.mjs` repeats this logic in plain JavaScript; a test keeps the two in step.
 */
export const CURRENT_VERSION = "v2";
const LEGACY_VERSION = "v1";
const INFO = "miasdr:integration-credentials:v1";

function deriveKey(secret: string): Buffer {
  if (secret.length < 32) throw new Error("INTEGRATION_CREDENTIALS_KEY must be at least 32 characters.");
  return Buffer.from(hkdfSync("sha256", secret, "", INFO, 32));
}

/** Short public fingerprint of a secret. Safe to log and to store in an envelope. */
export function credentialKeyId(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

/** The version label an envelope carries, for the `encryption_version` column. */
export function envelopeVersion(envelope: string): string {
  return envelope.slice(0, envelope.indexOf(":"));
}

function seal(plaintext: string, secret: string, parts: (iv: string, tag: string, body: string) => string[]): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return parts(iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")).join(":");
}

function open(secret: string, iv: string, tag: string, body: string): string {
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

/** Always writes the current envelope version with the key you pass. */
export function encryptCredential(plaintext: string, secret: string): string {
  const keyId = credentialKeyId(secret);
  return seal(plaintext, secret, (iv, tag, body) => [CURRENT_VERSION, keyId, iv, tag, body]);
}

/** Writes the old `v1` envelope. Only tests and migration fixtures need it. */
export function encryptCredentialV1(plaintext: string, secret: string): string {
  return seal(plaintext, secret, (iv, tag, body) => [LEGACY_VERSION, iv, tag, body]);
}

/**
 * Throws when the envelope is malformed, the version is unknown, no known key matches the key id,
 * or the data was altered. `secret` is the current key; `legacySecrets` are older keys that may still
 * protect stored rows. An unknown key id error names the id, never a key.
 */
export function decryptCredential(envelope: string, secret: string, legacySecrets: readonly string[] = []): string {
  const parts = envelope.split(":");
  const keys = [secret, ...legacySecrets];
  if (parts[0] === CURRENT_VERSION && parts.length === 5 && parts[2] && parts[3] && parts[4] !== undefined) {
    const [, keyId, iv, tag, body] = parts;
    const match = keys.find((candidate) => credentialKeyId(candidate) === keyId);
    if (!match) throw new Error(`No known key matches credential key id ${keyId}. Add the old key to INTEGRATION_CREDENTIALS_LEGACY_KEYS.`);
    return open(match, iv, tag, body);
  }
  if (parts[0] === LEGACY_VERSION && parts.length === 4 && parts[1] && parts[2] && parts[3] !== undefined) {
    const [, iv, tag, body] = parts;
    let failure: unknown;
    for (const candidate of keys) {
      try {
        return open(candidate, iv, tag, body);
      } catch (error) {
        failure ??= error;
      }
    }
    throw failure;
  }
  throw new Error("Unsupported credential envelope.");
}

/** Splits a comma separated key list, dropping blanks. */
export function parseLegacyKeys(value: string | undefined): string[] {
  return (value ?? "").split(",").map((key) => key.trim()).filter(Boolean);
}
