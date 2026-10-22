import { describe, expect, it } from "vitest";
import { classificationJsonSchema, classificationSchema, draftSchema, LINKEDIN_DRAFT_JSON_SCHEMA, linkedinDraftSchema } from "./ai-contract";

describe("closed classification schema", () => {
  const schema = classificationSchema(["demo_request", "other"]);
  it("accepts a listed key and trims the reason", () => {
    expect(schema.parse({ subcategoryKey: "demo_request", confidence: 0.5, reason: "  ok  " })).toEqual({ subcategoryKey: "demo_request", confidence: 0.5, reason: "ok" });
  });
  it("rejects unknown keys, extra fields and out-of-range confidence", () => {
    expect(schema.safeParse({ subcategoryKey: "send_money", confidence: 1, reason: "x" }).success).toBe(false);
    expect(schema.safeParse({ subcategoryKey: "other", confidence: 1, reason: "x", action: "send" }).success).toBe(false);
    expect(schema.safeParse({ subcategoryKey: "other", confidence: 1.2, reason: "x" }).success).toBe(false);
    expect(schema.safeParse({ subcategoryKey: "other", confidence: Number.NaN, reason: "x" }).success).toBe(false);
  });
  it("sends the provider an enum of exactly the allowed keys and no range keywords", () => {
    const json = classificationJsonSchema(["a", "b"]);
    expect(json.properties.subcategoryKey.enum).toEqual(["a", "b"]);
    expect(JSON.stringify(json)).not.toMatch(/minimum|maximum|minLength|maxLength/);
  });
  it("requires a body for a draft", () => {
    expect(draftSchema.safeParse({ subject: "Re: x", bodyText: "  " }).success).toBe(false);
  });
});

describe("LinkedIn draft schema", () => {
  it("asks the provider for a body only, tolerates a stray subject and caps the body at LinkedIn's limit", () => {
    expect(Object.keys(LINKEDIN_DRAFT_JSON_SCHEMA.properties)).toEqual(["bodyText"]);
    expect(linkedinDraftSchema.safeParse({ subject: "Re: x", bodyText: "Hi" }).success).toBe(true);
    expect(linkedinDraftSchema.safeParse({ bodyText: "x".repeat(8000) }).success).toBe(true);
    expect(linkedinDraftSchema.safeParse({ bodyText: "x".repeat(8001) }).success).toBe(false);
    expect(linkedinDraftSchema.safeParse({ bodyText: "  " }).success).toBe(false);
  });
});
