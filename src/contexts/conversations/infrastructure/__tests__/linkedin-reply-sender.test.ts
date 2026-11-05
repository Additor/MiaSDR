import { describe, expect, it } from "vitest";
import { LinkedInGatewayError, type LinkedInGateway, type LinkedInGatewayProvider } from "@/contexts/outreach/linkedin/application/linkedin-ports";
import { createLinkedInReplySender } from "../linkedin-reply-sender";

const address = { organizationId: "o", accountId: "a", account: "ln_ac_1", chat: "member:ACoAAlead", member: "ACoAAlead", slug: null };
const sender = (gateway: Partial<LinkedInGateway>) => createLinkedInReplySender({ forAccount: async () => gateway as LinkedInGateway } as LinkedInGatewayProvider);

describe("the LinkedIn reply sender", () => {
  it("passes the attempt's key and the draft's moment through to the gateway", async () => {
    const seen: unknown[] = [];
    const at = new Date("2026-11-01T00:00:00Z");
    await sender({ sendMessage: async (input) => (seen.push(input), { chat: null, messageId: "m" }) }).send({ ...address, text: "Hi", sendKey: "attempt-1", unlessRepliedAfter: at });
    expect(seen[0]).toMatchObject({ sendKey: "attempt-1", unlessRepliedAfter: at });
  });

  it("says in fixed words that the person wrote again, as a definite refusal", async () => {
    const refusal = new LinkedInGatewayError("gtm-api: upstream words (replied)", "definite", "replied");
    const error = await sender({ sendMessage: async () => Promise.reject(refusal) })
      .send({ ...address, text: "Hi", sendKey: "k", unlessRepliedAfter: new Date() })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "The person wrote again after this draft. Read their message, then write the reply again.", kind: "definite", code: "other" });
  });

  it("pauses nothing on a refusal about this person's thread", async () => {
    const refusal = new LinkedInGatewayError("gtm-api: busy (reply_check_unavailable)", "definite", "rate_limited", 300_000, "recipient");
    const error = await sender({ sendMessage: async () => Promise.reject(refusal) })
      .send({ ...address, text: "Hi", sendKey: "k", unlessRepliedAfter: null })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "definite", code: "other" });
  });

  it("looks for a sent reply by its key", async () => {
    const seen: unknown[] = [];
    await sender({ findSentMessage: async (input) => (seen.push(input), null) }).findSent({ ...address, text: "Hi", since: new Date(), sendKey: "attempt-1" });
    expect(seen[0]).toMatchObject({ sendKey: "attempt-1" });
  });
});
