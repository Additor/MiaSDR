import { LinkedInGatewayError, type LinkedInGateway, type LinkedInGatewayProvider } from "@/contexts/outreach/linkedin/application/linkedin-ports";
import { LinkedInReplyError, type LinkedInSentFinder } from "../application/linkedin-reply-ports";

/** A gateway refusal as the reply path reads it. A refusal about this person's thread says nothing about the account, so it pauses nothing. */
export function toReplyError(error: LinkedInGatewayError): LinkedInReplyError {
  if (error.code === "replied") return new LinkedInReplyError("The person wrote again after this draft. Read their message, then write the reply again.", "definite", "other");
  const code = error.code === "rate_limited" && error.limits !== "recipient" ? "rate_limited" : error.code === "auth" ? "auth" : "other";
  return new LinkedInReplyError(error.message, error.kind, code, error.retryAfterMs);
}

/** Looks in a LinkedIn chat for a reply that may have gone out. It holds no way to send. */
export function createLinkedInSentFinder(gateways: LinkedInGatewayProvider): LinkedInSentFinder {
  const operationsOf = async (input: { organizationId: string; accountId: string }) => {
    const operations = ((await gateways.forAccount(input)) as LinkedInGateway | null)?.operations;
    if (!operations) throw new Error("LinkedIn is not connected");
    return operations;
  };
  return {
    async available(input) {
      return (await gateways.forAccount(input)) !== null;
    },
    async findSent(input) {
      const gateway = await gateways.forAccount(input);
      if (!gateway) throw new Error("LinkedIn is not connected");
      const found = await gateway.findSentMessage({ account: input.account, to: { chat: input.chat, member: input.member, slug: input.slug }, text: input.text, since: input.since, sendKey: input.sendKey });
      // Nothing resends a reply, so "a person settles it" is what a missing message already leads to.
      return found === "ask_a_person" ? null : found;
    },
    async progress(input) {
      const read = await (await operationsOf(input)).progress({ account: input.account, operation: input.operation, kind: "message" });
      if (read.state === "failed") return { state: "failed", error: toReplyError(read.error) };
      return read.state === "finished" ? { state: "finished", messageId: read.value.messageId } : read;
    },
    async cancel(input) {
      return (await operationsOf(input)).cancel({ account: input.account, operation: input.operation });
    },
  };
}
