import { describe, expect, it } from "vitest";
import * as script from "../../../../../scripts/rotate-credentials.mjs";
import { credentialKeyId, decryptCredential, encryptCredential, encryptCredentialV1 } from "../credential-crypto";

/** scripts/rotate-credentials.mjs repeats the envelope code because it runs under plain node. These tests keep both copies in step. */
const key = "k".repeat(40);
const oldKey = "o".repeat(40);

describe("rotate-credentials.mjs and credential-crypto.ts agree", () => {
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
