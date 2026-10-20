import { describe, expect, it } from "vitest";
import { managedProvider, validateCredentialInput } from "./providers";

const anthropic = managedProvider("anthropic")!;

describe("validateCredentialInput", () => {
  it("trims and keeps only declared fields", () => {
    expect(validateCredentialInput(anthropic, { apiKey: "  sk-1 ", extra: "x" })).toEqual({ ok: true, values: { apiKey: "sk-1" } });
  });
  it("requires every field", () => {
    expect(validateCredentialInput(anthropic, { apiKey: "   " })).toEqual({ ok: false, reason: "API key is required." });
    expect(validateCredentialInput(anthropic, {})).toMatchObject({ ok: false });
    expect(validateCredentialInput(anthropic, { apiKey: 5 })).toMatchObject({ ok: false });
  });
  it("caps the length", () => {
    expect(validateCredentialInput(anthropic, { apiKey: "a".repeat(2001) })).toMatchObject({ ok: false });
  });
});

describe("managedProvider", () => {
  it("does not manage unipile", () => {
    expect(managedProvider("unipile")).toBeUndefined();
  });
});
