import { describe, expect, it } from "vitest";
import * as script from "../../../../../scripts/rotate-credentials.mjs";
import { credentialKeyId, decryptCredential, encryptCredential, encryptCredentialV1 } from "../credential-crypto";

/** scripts/rotate-credentials.mjs repeats the envelope code because it runs under plain node. These tests keep both copies in step. */
const key = "k".repeat(40);
const oldKey = "o".repeat(40);

/** Envelopes credential-crypto.ts wrote once (see credential-crypto.test.ts). The script must open rows the app stored. */
const FIXED = {
  key: "fixed-vector-key-0123456789abcdefghij",
  legacyKey: "fixed-vector-legacy-key-0123456789abcd",
  v2: "v2:8f35df7f:GXhIX14ReocRVgOO:UWjTH3rqrUoiiDVno4wkSQ:VMZTUWZIwbz2_HOvl2r8gqhrF2zJm-be",
  v1Legacy: "v1:NR7th5VJMPJ68QuU:2nvIRDZNWmNyLW3O-Cx7jA:HMQ7akkxAj_bOSQ-af5bNe5l9YFMJpb8",
};

describe("rotate-credentials.mjs and credential-crypto.ts agree", () => {
  it("opens stored v1 and v2 envelopes", () => {
    expect(script.decryptWithKeys(FIXED.v2, [FIXED.key])).toEqual({ plaintext: '{"apiKey":"sk-fixed-v2"}', keyId: "8f35df7f" });
    expect(script.decryptWithKeys(FIXED.v1Legacy, [FIXED.key, FIXED.legacyKey])).toEqual({ plaintext: '{"apiKey":"sk-fixed-v1"}', keyId: "a24a3cf7" });
  });
  it("derives the same key id", () => {
    expect(script.credentialKeyId(key)).toBe(credentialKeyId(key));
  });
  it("script encrypts, TypeScript decrypts", () => {
    const envelope: string = script.encryptCredential('{"apiKey":"from-script"}', key);
    expect(envelope.split(":")[0]).toBe("v2");
    expect(decryptCredential(envelope, key)).toBe('{"apiKey":"from-script"}');
  });
  it("TypeScript encrypts, script decrypts", () => {
    const result = script.decryptWithKeys(encryptCredential("from-ts", key), [key]);
    expect(result).toEqual({ plaintext: "from-ts", keyId: credentialKeyId(key) });
  });
  it("script decrypts a v1 envelope under a legacy key and reports that key id", () => {
    const result = script.decryptWithKeys(encryptCredentialV1("v1-data", oldKey), [key, oldKey]);
    expect(result).toEqual({ plaintext: "v1-data", keyId: credentialKeyId(oldKey) });
  });
  it("script failures carry the key id and never a key", () => {
    const envelope = encryptCredential("x", oldKey);
    let message = "";
    try {
      script.decryptWithKeys(envelope, [key]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(credentialKeyId(oldKey));
    expect(message).not.toContain(oldKey);
  });
});
