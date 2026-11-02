import { mailboxProvider } from "@/contexts/outreach/infrastructure/composition";
import { linkedinGateways } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import type { LinkedInReplySendDeps } from "../application/linkedin-reply";
import type { ReplySendDeps } from "../application/reply-management";
import { linkedinReplyDeps, replyDeps } from "../ai/infrastructure/ai-composition";
import { createLinkedInReplySender } from "./linkedin-reply-sender";
import { createReplyMailer } from "./reply-mailer";

/**
 * The only deps that can send a reply. Two routes import this module, the Send button's email and LinkedIn routes;
 * `reply-send-imports.test.ts` keeps it that way and keeps the background jobs from reaching it.
 */
export const replySendDeps = (): ReplySendDeps => ({ ...replyDeps(), mailer: createReplyMailer(mailboxProvider) });

export const linkedinReplySendDeps = (): LinkedInReplySendDeps => ({ ...linkedinReplyDeps(), sender: createLinkedInReplySender(linkedinGateways()) });
