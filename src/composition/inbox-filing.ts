import { receiveInbound, receiveInboundLinkedIn } from "@/contexts/conversations/infrastructure/composition";
import type { InboxFiling } from "@/contexts/outreach/application/inbound-ports";
import { linkedinOperationsDeps, receiveUnipileDelivery } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";

/** Outreach syncs mail and LinkedIn; conversations files what arrives. This is the one place the two meet. */
export const inboxFiling: InboxFiling = { email: receiveInbound, linkedin: receiveInboundLinkedIn };

/** LinkedIn job operations (overview, replay, counter reset) with webhook replay filing into the Inbox. */
export const linkedinOperations = () => linkedinOperationsDeps(inboxFiling);

/** One Unipile webhook delivery, filed into the Inbox. */
export const receiveUnipileWebhook = (input: Parameters<typeof receiveUnipileDelivery>[1]) => receiveUnipileDelivery(inboxFiling, input);
