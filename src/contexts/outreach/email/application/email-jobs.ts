import { isOutboundPaused } from "@/shared/outbound-pause";
import type { Job } from "@/platform/jobs/types";
import { recheckFailedMailboxes, reconcileUncertainSends, sendNextEmail, type EngineDeps } from "./send-next-email";

const REFUSED_BLOCKS = ["mailbox_unavailable", "provider_unavailable"];

/** One tick: reconcile first (it may release or settle steps), then send at most one email per mailbox. */
export function createEmailJobs(deps: EngineDeps): Job[] {
  return [
    {
      name: "email.reconcile",
      failureKeys: [],
      async run() {
        const report = await reconcileUncertainSends(deps);
        return {
          processed: report.foundSent + report.retryable, more: report.checked >= 25,
          detail: {
            checked: report.checked,
            found_sent: report.foundSent,
            retryable: report.retryable,
            waiting: report.stillWaiting,
            reconcile_inconclusive: report.inconclusive,
          },
        };
      },
    },
    {
      name: "email.mailbox-recheck",
      failureKeys: [],
      async run(ctx) {
        const report = await recheckFailedMailboxes(deps, ctx.deadline);
        return { processed: report.recovered, more: false, detail: { checked: report.checked } };
      },
    },
    {
      name: "email.send",
      // A refused send gives its attempt back and blocks the mailbox, which is still a send the provider refused.
      failureKeys: ["failed", ...REFUSED_BLOCKS],
      async run(ctx) {
        // Queue build: while PAUSE_OUTBOUND is set, do not even list sendable mailboxes.
        if (isOutboundPaused()) return { processed: 0, more: false, detail: { paused: 1 } };
        let processed = 0;
        const policy = deps.domainPolicy ?? { allowedDomains: null, openSignup: false };
        const { ids, blockedByDomainPolicy } = await deps.store.listSendableMailboxIds(ctx.now(), policy);
        if (blockedByDomainPolicy > 0) {
          const reason = policy.allowedDomains
            ? `outside MAILBOX_ALLOWED_DOMAINS (${policy.allowedDomains.join(", ")})`
            : "AUTH_SIGNUP=open without MAILBOX_ALLOWED_DOMAINS";
          console.warn(`email.send skipped ${blockedByDomainPolicy} connected mailbox(es): ${reason}.`);
        }
        const detail: Record<string, number> = { blocked_by_domain_policy: blockedByDomainPolicy };
        for (const mailboxId of ids) {
          if (Date.now() >= ctx.deadline) return { processed, more: true, detail };
          const outcome = await sendNextEmail(deps, mailboxId);
          if (outcome.kind === "sent") processed += 1;
          else if (outcome.kind !== "idle") detail[outcome.kind] = (detail[outcome.kind] ?? 0) + 1;
          if (outcome.kind === "blocked" && REFUSED_BLOCKS.includes(outcome.reason)) detail[outcome.reason] = (detail[outcome.reason] ?? 0) + 1;
        }
        return { processed, more: false, detail };
      },
    },
  ];
}
