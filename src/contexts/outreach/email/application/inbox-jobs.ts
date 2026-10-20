import type { Job } from "@/platform/jobs/types";
import { syncMailboxInbox, type InboundCounts, type InboxDeps } from "./sync-inbox";

/** One tick: sync due mailboxes one at a time until the budget runs out. A failing mailbox does not stop the others. */
export function createInboxJobs(deps: InboxDeps): Job[] {
  return [
    {
      name: "email.inbox-sync",
      async run(ctx) {
        const dueBefore = new Date(ctx.now().getTime() - deps.minIntervalSeconds * 1000);
        const detail: Record<string, number> = {};
        const add = (counts: InboundCounts) => {
          for (const [key, value] of Object.entries(counts)) detail[key] = (detail[key] ?? 0) + (value ?? 0);
        };
        let processed = 0;
        for (const mailboxId of await deps.store.listDueMailboxIds(dueBefore)) {
          if (Date.now() >= ctx.deadline) return { processed, more: true, detail };
          const outcome = await syncMailboxInbox(deps, mailboxId);
          if (outcome.kind === "skipped") continue;
          if (outcome.kind === "failed") detail.mailboxes_failed = (detail.mailboxes_failed ?? 0) + 1;
          else processed += 1;
          add(outcome.counts);
        }
        return { processed, more: false, detail };
      },
    },
  ];
}
