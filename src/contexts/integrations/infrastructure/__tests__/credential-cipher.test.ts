import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const current = "c".repeat(40);
const old = "o".repeat(40);

describe("credentialCipher", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [k, v] of Object.entries({
      DATABASE_URL: "postgres://x", APP_URL: "http://localhost:3000", BETTER_AUTH_SECRET: "a".repeat(40), UNSUBSCRIBE_SECRET: "u".repeat(40),
      INTEGRATION_CREDENTIALS_KEY: current, INTEGRATION_CREDENTIALS_LEGACY_KEYS: old,
    })) vi.stubEnv(k, v);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("encrypts with the current key and decrypts with current and legacy keys", async () => {
    const { credentialCipher } = await import("../credential-cipher");
    const { encryptCredential, credentialKeyId } = await import("../credential-crypto");
    const envelope = credentialCipher.encrypt("hello");
    expect(envelope.split(":")[1]).toBe(credentialKeyId(current));
    expect(credentialCipher.decrypt(envelope)).toBe("hello");
    expect(credentialCipher.decrypt(encryptCredential("legacy", old))).toBe("legacy");
  });
  it("fails on a key that is neither current nor legacy", async () => {
    const { credentialCipher } = await import("../credential-cipher");
    const { encryptCredential } = await import("../credential-crypto");
    expect(() => credentialCipher.decrypt(encryptCredential("x", "z".repeat(40)))).toThrow(/key id/);
  });
  it("rejects a legacy key shorter than 32 characters at env validation", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIALS_LEGACY_KEYS", `${old},short`);
    const { credentialCipher } = await import("../credential-cipher");
    expect(() => credentialCipher.decrypt("v2:aaaaaaaa:a:b:c")).toThrow(/Invalid environment/);
  });
});
