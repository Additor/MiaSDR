import { MAX_EVENT_ATTEMPTS, eventRetrySeconds } from "../domain/linkedin";
import { errorText } from "@/shared/error-text";
import type { LedgerEvent, LinkedInInboundDeps } from "./linkedin-ports";

export type WebhookResult =
  | { status: "ignored" }
  | { status: "duplicate" }
  | { status: "done" | "skipped" }
  /** Stored, processing failed. The replay job retries it. */
  | { status: "failed"; error: string };

/**
 * One authenticated delivery: write the ledger row first, then process synchronously. A failure is
 * recorded for replay and the delivery still counts as received, so the provider's own retries stay quiet.
 * Throws only when the ledger write fails, which is the one case where the provider should retry.
 */
export async function receiveLinkedInWebhook(deps: LinkedInInboundDeps, input: { organizationId: string; provider: string; payload: unknown }): Promise<WebhookResult> {
  const event = deps.parse(input.payload);
  if (!event) {
    // An event we act on that we cannot read: the vendor changed its shape, and a reply may be inside. It stays on Inbound events.
    const unreadable = deps.unreadable?.(input.payload);
    if (unreadable) await deps.store.recordUnreadable({ organizationId: input.organizationId, provider: input.provider, eventType: unreadable, payload: input.payload, now: deps.clock.now() });
    return { status: "ignored" };
  }
  const key = deps.eventKey(event, input.organizationId, input.payload);
  // No id to key it on: the same changed shape, read one field further in.
  if (!key) {
    await deps.store.recordUnreadable({ organizationId: input.organizationId, provider: input.provider, eventType: event.type, payload: input.payload, now: deps.clock.now() });
    return { status: "ignored" };
  }

  const now = deps.clock.now();
  const row = await deps.store.begin({
    organizationId: input.organizationId,
    provider: input.provider,
    key,
    eventType: event.type,
    accountRef: event.account,
    payload: input.payload,
    now,
  });
  if (!row) return { status: "duplicate" };
  return process(deps, row, input.organizationId, input.payload);
}

async function process(deps: LinkedInInboundDeps, claim: LedgerEvent, organizationId: string, payload: unknown): Promise<WebhookResult> {
  try {
    const event = deps.parse(payload);
    if (!event || !deps.eventKey(event, organizationId, payload)) {
      // An event this app acts on: a reply may be inside, and with no id it would share one idempotency key with every other like it.
      if (event || deps.unreadable?.(payload)) {
        const error = "MiaSDR still cannot read this delivery.";
        await deps.store.fail(claim, error, deps.clock.now(), null);
        return { status: "failed", error };
      }
      await deps.store.finish(claim, "skipped", "Payload no longer parses.", deps.clock.now());
      return { status: "skipped" };
    }
    const { result, note } = await deps.store.apply(organizationId, event, deps.clock.now());
    await deps.store.finish(claim, result, note, deps.clock.now());
    return { status: result };
  } catch (error) {
    const now = deps.clock.now();
    const message = errorText(error);
    const retryAt = claim.attempts >= MAX_EVENT_ATTEMPTS ? null : new Date(now.getTime() + eventRetrySeconds(claim.attempts) * 1000);
    await deps.store.fail(claim, message.slice(0, 500), now, retryAt);
    return { status: "failed", error: message };
  }
}

export interface ReplayReport {
  /** Rows whose worker stopped during the last attempt, failed so an admin can replay them. */
  stopped: number;
  claimed: number;
  done: number;
  failed: number;
}

/** Re-runs failed deliveries and ones whose worker died mid-way. Handling is idempotent. */
/** `organizationId` limits the run to one tenant's rows (an admin's replay button). The job passes none and serves everyone. */
export async function replayLinkedInEvents(deps: LinkedInInboundDeps, limit = 50, organizationId?: string): Promise<ReplayReport> {
  const report: ReplayReport = { stopped: await deps.store.failStoppedAtCap(deps.clock.now(), organizationId), claimed: 0, done: 0, failed: 0 };
  for (const row of await deps.store.claimReplayable(deps.clock.now(), limit, 300, organizationId)) {
    report.claimed += 1;
    if (!row.organizationId) {
      await deps.store.fail(row, "No organization on the event.", deps.clock.now(), null);
      report.failed += 1;
      continue;
    }
    const result = await process(deps, row, row.organizationId, row.payload);
    if (result.status === "failed") report.failed += 1;
    else report.done += 1;
  }
  return report;
}
