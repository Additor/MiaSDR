import { receiveInbound, receiveInboundLinkedIn } from "@/contexts/conversations/infrastructure/composition";
import { contactStop } from "@/contexts/conversations/stopping/infrastructure/stop-contact";
import type { InboxFiling, PersonTimeline } from "@/contexts/outreach/application/inbound-ports";
import { suppressionListDeps, unsubscribeDeps } from "@/contexts/outreach/infrastructure/composition";
import { enrollmentRestoreDeps } from "@/contexts/outreach/infrastructure/restore-composition";
import { appendPersonEvent } from "@/contexts/conversations/infrastructure/person-handling";
import { linkedinOperationsDeps, receiveUnipileDelivery } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";

/** Outreach syncs mail and LinkedIn; conversations files what arrives and owns the stop. This is the one place the two meet. */
export const inboxFiling: InboxFiling = { email: receiveInbound, linkedin: receiveInboundLinkedIn };

export { contactStop };

/** The public unsubscribe link, with its suppression wired to the contact stop. */
export const unsubscribe = () => unsubscribeDeps(contactStop);

/** Settings, Suppression list, with additions wired to the contact stop like the unsubscribe link. */
export const suppressions = () => suppressionListDeps(contactStop);

/** LinkedIn job operations (overview, replay, counter reset) with webhook replay filing into the Inbox. */
export const linkedinOperations = () => linkedinOperationsDeps(inboxFiling);

/** One Unipile webhook delivery, filed into the Inbox. */
export const receiveUnipileWebhook = (input: Parameters<typeof receiveUnipileDelivery>[1]) => receiveUnipileDelivery(inboxFiling, input);

/** An enrollment change a person made in outreach lands on the person's timeline, which conversations owns. */
export const personTimeline: PersonTimeline = { append: appendPersonEvent };

/** Restore of removed leads, recording each restore on the person's timeline. */
export const enrollmentRestore = () => enrollmentRestoreDeps(personTimeline);
