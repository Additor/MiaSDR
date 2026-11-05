import { LinkedInGatewayError, type LinkedInGatewayProvider } from "@/contexts/outreach/linkedin/application/linkedin-ports";
import { LinkedInReplyError, type LinkedInReplySender } from "../application/linkedin-reply-ports";
import { createLinkedInSentFinder } from "./linkedin-sent-finder";

/**
 * Sends a reply through the same gateway the sequence engine uses. A gateway refusal keeps its definite/unknown meaning;
 * any other error is unknown.
 */
export function createLinkedInReplySender(gateways: LinkedInGatewayProvider): LinkedInReplySender {
  return {
    ...createLinkedInSentFinder(gateways),
    async send(input) {
      const gateway = await gateways.forAccount(input);
      if (!gateway) throw new LinkedInReplyError("LinkedIn is not connected for this organization.", "definite", "other");
      try {
        return await gateway.sendMessage({ account: input.account, to: { chat: input.chat, member: input.member, slug: input.slug }, text: input.text, sendKey: input.sendKey, unlessRepliedAfter: input.unlessRepliedAfter });
      } catch (error) {
        if (error instanceof LinkedInGatewayError) {
          if (error.code === "replied") throw new LinkedInReplyError("The person wrote again after this draft. Read their message, then write the reply again.", "definite", "other");
          // A refusal about this person's thread says nothing about the account, so it pauses nothing.
          const code = error.code === "rate_limited" && error.limits !== "recipient" ? "rate_limited" : error.code === "auth" ? "auth" : "other";
          throw new LinkedInReplyError(error.message, error.kind, code, error.retryAfterMs);
        }
        throw error;
      }
    },
  };
}
