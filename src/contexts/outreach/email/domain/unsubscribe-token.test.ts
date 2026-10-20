import { describe, expect, it } from "vitest";
import { createUnsubscribeToken, unsubscribeLinks, verifyUnsubscribeToken } from "./unsubscribe-token";

const secret = "s".repeat(40);
const org = "11111111-1111-4111-8111-111111111111";

describe("unsubscribe token", () => {
  it("round-trips and lowercases the address", () => {
    const token = createUnsubscribeToken(secret, org, " Ann@Acme.com ");
    expect(verifyUnsubscribeToken(secret, token)).toEqual({ organizationId: org, email: "ann@acme.com" });
  });
  it("rejects a different secret, a tampered address and garbage", () => {
    const token = createUnsubscribeToken(secret, org, "ann@acme.com");
    expect(verifyUnsubscribeToken("x".repeat(40), token)).toBeNull();
    const tampered = Buffer.from(Buffer.from(token, "base64url").toString().replace("ann@", "eve@")).toString("base64url");
    expect(verifyUnsubscribeToken(secret, tampered)).toBeNull();
    expect(verifyUnsubscribeToken(secret, "nope")).toBeNull();
    expect(verifyUnsubscribeToken(secret, "")).toBeNull();
  });
  it("does not transfer between organizations", () => {
    const token = createUnsubscribeToken(secret, org, "ann@acme.com");
    const swapped = Buffer.from(Buffer.from(token, "base64url").toString().replace(org, "22222222-2222-4222-8222-222222222222")).toString("base64url");
    expect(verifyUnsubscribeToken(secret, swapped)).toBeNull();
  });
});

describe("unsubscribeLinks", () => {
  it("points the body link at the page and the header link at the POST endpoint, with the same token", () => {
    const { pageUrl, oneClickUrl } = unsubscribeLinks("https://app.example.com", secret, org, "Ann@Acme.com");
    expect(pageUrl.startsWith("https://app.example.com/unsubscribe?token=")).toBe(true);
    expect(oneClickUrl.startsWith("https://app.example.com/api/outreach/unsubscribe?token=")).toBe(true);
    const tokenOf = (url: string) => new URL(url).searchParams.get("token") as string;
    expect(tokenOf(pageUrl)).toBe(tokenOf(oneClickUrl));
    expect(verifyUnsubscribeToken(secret, tokenOf(oneClickUrl))).toEqual({ organizationId: org, email: "ann@acme.com" });
  });
});
