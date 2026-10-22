import { receiveInbound, receiveInboundLinkedIn } from "@/contexts/conversations/infrastructure/composition";
import { followUpStop } from "@/contexts/conversations/after-reply/infrastructure/sequence-stop";
import type { FollowUpStop, InboxFiling } from "@/contexts/outreach/application/inbound-ports";
import { suppressionListDeps, unsubscribeDeps } from "@/contexts/outreach/infrastructure/composition";
import { linkedinOperationsDeps, receiveUnipileDelivery } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";

/** Outreach syncs mail and LinkedIn; conversations files what arrives and runs the follow-ups. This is the one place the two meet. */
export const inboxFiling: InboxFiling = { email: receiveInbound, linkedin: receiveInboundLinkedIn };

/** Suppressing an address in outreach ends the person's follow-up sequences in conversations, in the same transaction. */
export const followUps: FollowUpStop = followUpStop;

/** The public unsubscribe link, with its suppression wired to the follow-up stop. */
export const unsubscribe = () => unsubscribeDeps(followUps);

/** Settings, Suppression list, with additions wired to the follow-up stop like the unsubscribe link. */
export const suppressions = () => suppressionListDeps(followUps);

/** LinkedIn job operations (overview, replay, counter reset) with webhook replay filing into the Inbox. */
export const linkedinOperations = () => linkedinOperationsDeps(inboxFiling);

/** One Unipile webhook delivery, filed into the Inbox. */
export const receiveUnipileWebhook = (input: Parameters<typeof receiveUnipileDelivery>[1]) => receiveUnipileDelivery(inboxFiling, input);
