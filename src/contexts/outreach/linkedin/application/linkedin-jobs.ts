import { isOutboundPaused } from "@/shared/outbound-pause";
import type { Job, SlotPort } from "@/platform/jobs/types";
import { replayLinkedInEvents } from "./linkedin-inbound";
import { storedGateway, syncAndRecord, syncErrorText, type LinkedInManagementDeps } from "./linkedin-management";
import type { LinkedInEngineDeps, LinkedInInboundDeps } from "./linkedin-ports";
import type { LinkedInSearchEngineDeps } from "./linkedin-search-ports";
import { runNextSearchPage } from "./run-linkedin-search";
import { reconcileLinkedInSends, runNextLinkedInAction } from "./send-next-linkedin";

const SYNC_LEASE_MS = 120_000;
const SYNC_RETRY_MS = 10 * 60_000;

/**
 * Per tick: replay failed webhook events (so a reply stops its sequence before sends are claimed),
 * reconcile unknown outcomes, read search pages, then give every due account one unit of work.
 */
export function createLinkedInJobs(engine: LinkedInEngineDeps, inbound: LinkedInInboundDeps, search: LinkedInSearchEngineDeps, management: LinkedInManagementDeps, slots: SlotPort): Job[] {
  return [
    {
      // One sync per organization per UTC hour, so a disconnected account shows up without anyone pressing Sync.
      // A failed sync reopens its slot after ten minutes. Accounts stay as they are when the sync fails.
      name: "linkedin.sync-accounts",
      async run(ctx) {
        const hourKey = ctx.now().toISOString().slice(0, 13);
        const detail = { organizations: 0, connected: 0, disconnected: 0, added: 0, failed: 0 };
        for (const organizationId of await management.accounts.listCredentialedOrganizations()) {
          if (Date.now() >= ctx.deadline) return { processed: detail.organizations, more: true, detail };
          // Credentials that no longer decrypt read as null: nothing to sync, no slot, no error.
          const credentials = await management.accounts.getCredentials(organizationId);
          if (!credentials) continue;
          const claim = await slots.claim("linkedin-sync", hourKey, { organizationId, now: ctx.now(), leaseMs: SYNC_LEASE_MS });
          if (!claim) continue;
          detail.organizations += 1;
          try {
            const result = await syncAndRecord(management, organizationId, () => storedGateway(management, credentials));
            await slots.finish(claim, { status: "succeeded" }, ctx.now());
            detail.added += result.added;
            // A new account is `added`, not a status change.
            for (const change of result.changes) if (change.from !== null) detail[change.to] += 1;
          } catch (error) {
            detail.failed += 1;
            try {
              await slots.finish(claim, { status: "failed", error: syncErrorText(error), retryAfterMs: SYNC_RETRY_MS }, ctx.now());
            } catch (finishError) {
              // The lease expires on its own. The remaining organizations still get their turn.
              console.error(`LinkedIn sync: could not close the slot for organization ${organizationId}: ${finishError instanceof Error ? finishError.name : "unknown error"}`);
            }
          }
        }
        return { processed: detail.organizations, more: false, detail };
      },
    },
    {
      name: "linkedin.replay-events",
      async run() {
        const report = await replayLinkedInEvents(inbound);
        return { processed: report.done, more: report.claimed >= 50, detail: { failed: report.failed } };
      },
    },
    {
      name: "linkedin.reconcile",
      async run() {
        const report = await reconcileLinkedInSends(engine);
        return { processed: report.foundSent + report.retryable + report.expired, more: report.checked >= 25, detail: { waiting: report.stillWaiting } };
      },
    },
    {
      // One page per claim. The pacing gap lives on the rows, so the job never sleeps: a search that is not due is skipped.
      name: "linkedin.search",
      async run(ctx) {
        const detail: Record<string, number> = {};
        let processed = 0;
        while (Date.now() < ctx.deadline) {
          const outcome = await runNextSearchPage(search);
          if (outcome.kind === "idle") return { processed, more: false, detail };
          detail[outcome.kind] = (detail[outcome.kind] ?? 0) + 1;
          if (outcome.kind === "page" && outcome.skippedContact > 0) detail.skippedContact = (detail.skippedContact ?? 0) + outcome.skippedContact;
          processed += 1;
        }
        return { processed, more: true, detail };
      },
    },
    {
      name: "linkedin.run",
      async run(ctx) {
        // Queue build: while PAUSE_OUTBOUND is set, do not even list actionable accounts.
        if (isOutboundPaused()) return { processed: 0, more: false, detail: { paused: 1 } };
        let processed = 0;
        const detail: Record<string, number> = {};
        for (const account of await engine.store.listActionableAccounts(ctx.now())) {
          if (Date.now() >= ctx.deadline) return { processed, more: true, detail };
          const outcome = await runNextLinkedInAction(engine, account.id);
          if (outcome.kind === "idle") continue;
          detail[outcome.kind] = (detail[outcome.kind] ?? 0) + 1;
          processed += 1;
        }
        return { processed, more: false, detail };
      },
    },
  ];
}
