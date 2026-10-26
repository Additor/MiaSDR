import { describe, expect, it } from "vitest";
import { credentialKeyId, decryptCredential, encryptCredential, encryptCredentialV1, envelopeVersion, parseLegacyKeys } from "../credential-crypto";

const key = "k".repeat(40);
const oldKey = "o".repeat(40);

/**
 * Envelopes written once by this module and stored here. They pin the key derivation (HKDF-SHA256, empty salt, info
 * "miasdr:integration-credentials:v1"), the key id and the layout, so a change that would orphan stored rows fails.
 * A round trip cannot catch that: it encrypts and decrypts with the same changed code.
 */
const FIXED = {
  key: "fixed-vector-key-0123456789abcdefghij",
  legacyKey: "fixed-vector-legacy-key-0123456789abcd",
  v2: "v2:8f35df7f:GXhIX14ReocRVgOO:UWjTH3rqrUoiiDVno4wkSQ:VMZTUWZIwbz2_HOvl2r8gqhrF2zJm-be",
  v2Legacy: "v2:a24a3cf7:ZH0wD6ui6GRN9Zj6:wo_JT0akqnHsEYYisIJNsQ:ExstTdCzRaxGxl3T5j0YO_UreW8UHbfyiDDJX9aEaQ",
  v1Legacy: "v1:NR7th5VJMPJ68QuU:2nvIRDZNWmNyLW3O-Cx7jA:HMQ7akkxAj_bOSQ-af5bNe5l9YFMJpb8",
};

describe("credential envelope", () => {
  it("opens stored v1 and v2 envelopes", () => {
    expect(credentialKeyId(FIXED.key)).toBe("8f35df7f");
    expect(credentialKeyId(FIXED.legacyKey)).toBe("a24a3cf7");
    expect(decryptCredential(FIXED.v2, FIXED.key)).toBe('{"apiKey":"sk-fixed-v2"}');
    expect(decryptCredential(FIXED.v2Legacy, FIXED.key, [FIXED.legacyKey])).toBe('{"apiKey":"sk-fixed-v2-legacy"}');
    expect(decryptCredential(FIXED.v1Legacy, FIXED.key, [FIXED.legacyKey])).toBe('{"apiKey":"sk-fixed-v1"}');
  });
  it("round-trips and uses the v2 layout with the key id", () => {
    const envelope = encryptCredential('{"apiKey":"sk-secret"}', key);
    const parts = envelope.split(":");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v2");
    expect(parts[1]).toBe(credentialKeyId(key));
    expect(parts[1]).toMatch(/^[0-9a-f]{8}$/);
    expect(envelopeVersion(envelope)).toBe("v2");
    expect(envelope).not.toContain("sk-secret");
    expect(envelope).not.toContain(key);
    expect(decryptCredential(envelope, key)).toBe('{"apiKey":"sk-secret"}');
  });
  it("uses a fresh iv each time", () => {
    expect(encryptCredential("a", key)).not.toBe(encryptCredential("a", key));
  });
  it("still decrypts a v1 envelope with the current key", () => {
    const v1 = encryptCredentialV1("old-data", key);
    expect(v1.split(":")).toHaveLength(4);
    expect(envelopeVersion(v1)).toBe("v1");
    expect(decryptCredential(v1, key)).toBe("old-data");
  });
  it("decrypts a v1 envelope written under a legacy key", () => {
    expect(decryptCredential(encryptCredentialV1("old-data", oldKey), key, [oldKey])).toBe("old-data");
  });
  it("decrypts a v2 envelope written under a legacy key and ignores list order", () => {
    const envelope = encryptCredential("legacy-data", oldKey);
    expect(decryptCredential(envelope, key, ["z".repeat(40), oldKey])).toBe("legacy-data");
  });
  it("names the key id, not the key, when no known key matches", () => {
    const envelope = encryptCredential("data", oldKey);
    let message = "";
    try {
      decryptCredential(envelope, key, ["z".repeat(40)]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(credentialKeyId(oldKey));
    expect(message).not.toContain(oldKey);
    expect(message).not.toContain(key);
  });
  it("rejects a v1 envelope no known key opens", () => {
    expect(() => decryptCredential(encryptCredentialV1("x", oldKey), key, ["z".repeat(40)])).toThrow();
  });
  it("rejects tampering in tag and body, a swapped key id and unknown versions", () => {
    const envelope = encryptCredential("secret", key);
    const parts = envelope.split(":");
    const tamperedTag = [...parts];
    tamperedTag[3] = Buffer.alloc(16, 1).toString("base64url");
    expect(() => decryptCredential(tamperedTag.join(":"), key)).toThrow();
    const tamperedBody = [...parts];
    tamperedBody[4] = Buffer.from("tampered!").toString("base64url");
    expect(() => decryptCredential(tamperedBody.join(":"), key)).toThrow();
    const swapped = [...parts];
    swapped[1] = credentialKeyId(oldKey);
    expect(() => decryptCredential(swapped.join(":"), key, [oldKey])).toThrow();
    expect(() => decryptCredential(envelope.replace("v2:", "v9:"), key)).toThrow(/Unsupported/);
    expect(() => decryptCredential("garbage", key)).toThrow(/Unsupported/);
    expect(() => decryptCredential(`${envelope}:extra`, key)).toThrow(/Unsupported/);
  });
  it("rejects a wrong key", () => {
    expect(() => decryptCredential(encryptCredentialV1("s", key), "z".repeat(40))).toThrow();
  });
  it("refuses a key shorter than 32 characters", () => {
    expect(() => encryptCredential("a", "short")).toThrow(/32/);
    expect(() => decryptCredential(encryptCredentialV1("a", key), "short")).toThrow(/32/);
  });
  it("parses the legacy key list", () => {
    expect(parseLegacyKeys(undefined)).toEqual([]);
    expect(parseLegacyKeys(` a , ,b,`)).toEqual(["a", "b"]);
  });
});
