import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, type Actor } from "@/shared/errors";
import { readSendPause, type SendPause } from "../domain/send-pause";
import type { EmailRulesDeps } from "../email/application/email-rules";

/** The organization's own pause, which every member sees on the banner. Null while outreach runs. */
export async function getSendPause(deps: EmailRulesDeps, actor: Actor): Promise<SendPause | null> {
  return readSendPause(await deps.settings.get(actor.organizationId, "general"));
}

/** Pauses or resumes campaign emails and LinkedIn actions for the organization. `byName` names the person on the banner. */
export async function setSendPause(deps: EmailRulesDeps, actor: Actor, input: { paused: boolean; byName: string | null; now: Date }): Promise<SendPause | null> {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can pause or resume sending.");
  const current = await getSendPause(deps, actor);
  // Pausing twice keeps the first time and name, so the banner says when outreach actually stopped.
  if (input.paused && current) return current;
  if (!input.paused && !current) return null;
  await deps.settings.merge(actor.organizationId, "general", { sendingPaused: input.paused ? { at: input.now.toISOString(), byName: input.byName } : null }, actor.userId);
  return getSendPause(deps, actor);
}
