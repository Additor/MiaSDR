import { LinkedInGatewayError, type LinkedInGatewayProvider } from "@/contexts/outreach/linkedin/application/linkedin-ports";
import { LinkedInReplyError, type LinkedInReplySender } from "../application/linkedin-reply-ports";
import { createLinkedInSentFinder, toReplyError } from "./linkedin-sent-finder";

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
        throw error instanceof LinkedInGatewayError ? toReplyError(error) : error;
      }
    },
  };
}
