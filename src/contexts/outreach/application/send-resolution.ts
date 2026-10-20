import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { MAX_SEND_ATTEMPTS, retryDelayMinutes } from "../domain/send-policy";

/**
 * A person's call on an email send the provider never confirmed (status `unknown`), after checking the
 * mailbox's Sent folder. The reconciler leaves a send `unknown` when the mailbox cannot prove it sent or
 * unsent, because retrying on a guess can email a lead twice. Mirrors the reply flow's
 * `resolveUncertainSend` (conversations/application/reply-management.ts).
 */

export type ResolveOutcome = "resolved" | "not_found" | "not_unknown";

export interface SendResolutionStore {
  /**
   * One transaction, guarded on the send still being `unknown` and belonging to this email campaign
   * of this organization. `delivered` marks it sent and advances the enrollment exactly as a normal
   * send does. `not_delivered` marks it failed and schedules the retry the reconciler would have.
   */
  resolve(input: {
    organizationId: string;
    campaignId: string;
    sendId: string;
    outcome: "delivered" | "not_delivered";
    actorUserId: string;
    now: Date;
    retryDelayMinutes: (attemptJustFailed: number) => number;
    maxAttempts: number;
  }): Promise<ResolveOutcome>;
}

export interface SendResolutionDeps {
  sends: SendResolutionStore;
  now: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveCampaignSend(
  deps: SendResolutionDeps,
  actor: Actor,
  campaignId: string,
  sendId: string,
  input: { outcome: "delivered" | "not_delivered"; checkedSentFolder?: boolean },
): Promise<void> {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can settle an unconfirmed send.");
  if (!UUID.test(campaignId) || !UUID.test(sendId)) throw new NotFoundError("Send not found");
  // A wrong "not delivered" emails the lead a second time, so it needs an explicit confirmation.
  if (input.outcome === "not_delivered" && input.checkedSentFolder !== true) {
    throw new ValidationError("Confirm that you looked in the mailbox's Sent folder before marking a send as not delivered.");
  }
  const result = await deps.sends.resolve({
    organizationId: actor.organizationId,
    campaignId,
    sendId,
    outcome: input.outcome,
    actorUserId: actor.userId,
    now: deps.now(),
    retryDelayMinutes,
    maxAttempts: MAX_SEND_ATTEMPTS,
  });
  if (result === "not_found") throw new NotFoundError("Send not found");
  if (result === "not_unknown") throw new ConflictError("This send is no longer unconfirmed. Reload the page.");
}
