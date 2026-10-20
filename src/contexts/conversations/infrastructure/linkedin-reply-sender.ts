import { LinkedInGatewayError, type LinkedInGatewayProvider } from "@/contexts/outreach/linkedin/application/linkedin-ports";
import { LinkedInReplyError, type LinkedInReplySender } from "../application/linkedin-reply-ports";

/**
 * Sends a reply through the same gateway the sequence engine uses. The chat already exists (the lead wrote first), so
 * only `sendMessage` is called. A gateway refusal keeps its definite/unknown meaning; any other error is unknown.
 */
export function createLinkedInReplySender(gateways: LinkedInGatewayProvider): LinkedInReplySender {
  return {
    async available(organizationId) {
      return (await gateways.forOrganization(organizationId)) !== null;
    },
    async send(input) {
      const gateway = await gateways.forOrganization(input.organizationId);
      if (!gateway) throw new LinkedInReplyError("LinkedIn is not connected for this organization.", "definite", "other");
      try {
        return await gateway.sendMessage({ account: input.account, chat: input.chat, text: input.text });
      } catch (error) {
        if (error instanceof LinkedInGatewayError) {
          const code = error.code === "rate_limited" ? "rate_limited" : error.code === "auth" ? "auth" : "other";
          throw new LinkedInReplyError(error.message, error.kind, code);
        }
        throw error;
      }
    },
    async findSent(input) {
      const gateway = await gateways.forOrganization(input.organizationId);
      if (!gateway) throw new Error("LinkedIn is not connected");
      return gateway.findSentMessage({ account: input.account, chat: input.chat, text: input.text, since: input.since });
    },
  };
}
