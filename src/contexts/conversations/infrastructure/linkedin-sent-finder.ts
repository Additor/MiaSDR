import type { LinkedInGatewayProvider } from "@/contexts/outreach/linkedin/application/linkedin-ports";
import type { LinkedInSentFinder } from "../application/linkedin-reply-ports";

/** Looks in a LinkedIn chat for a reply that may have gone out. It holds no way to send. */
export function createLinkedInSentFinder(gateways: LinkedInGatewayProvider): LinkedInSentFinder {
  return {
    async available(input) {
      return (await gateways.forAccount(input)) !== null;
    },
    async findSent(input) {
      const gateway = await gateways.forAccount(input);
      if (!gateway) throw new Error("LinkedIn is not connected");
      return gateway.findSentMessage({ account: input.account, to: { chat: input.chat, member: input.member, slug: input.slug }, text: input.text, since: input.since, sendKey: input.sendKey });
    },
  };
}
