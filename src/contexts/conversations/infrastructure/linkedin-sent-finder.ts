import type { LinkedInGatewayProvider } from "@/contexts/outreach/linkedin/application/linkedin-ports";
import type { LinkedInSentFinder } from "../application/linkedin-reply-ports";

/** Looks in a LinkedIn chat for a reply that may have gone out. It holds no way to send. */
export function createLinkedInSentFinder(gateways: LinkedInGatewayProvider): LinkedInSentFinder {
  return {
    async available(organizationId) {
      return (await gateways.forOrganization(organizationId)) !== null;
    },
    async findSent(input) {
      const gateway = await gateways.forOrganization(input.organizationId);
      if (!gateway) throw new Error("LinkedIn is not connected");
      return gateway.findSentMessage({ account: input.account, chat: input.chat, text: input.text, since: input.since });
    },
  };
}
