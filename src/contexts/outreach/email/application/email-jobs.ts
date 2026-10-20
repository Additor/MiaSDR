import { isOutboundPaused } from "@/shared/outbound-pause";
import type { Job } from "@/platform/jobs/types";
import { reconcileUncertainSends, sendNextEmail, type EngineDeps } from "./send-next-email";

/** One tick: reconcile first (it may release or settle steps), then send at most one email per mailbox. */
export function createEmailJobs(deps: EngineDeps): Job[] {
  return [
    {
      name: "email.reconcile",
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
      name: "email.send",
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
        const detail = { blocked_by_domain_policy: blockedByDomainPolicy };
        for (const mailboxId of ids) {
          if (Date.now() >= ctx.deadline) return { processed, more: true, detail };
          const outcome = await sendNextEmail(deps, mailboxId);
          if (outcome.kind === "sent") processed += 1;
        }
        return { processed, more: false, detail };
      },
    },
  ];
}
