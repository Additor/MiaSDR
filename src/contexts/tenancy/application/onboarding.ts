import { ForbiddenError, type Actor } from "@/shared/errors";
import { deriveChecklist, type OnboardingChecklist, type OnboardingFacts } from "../domain/onboarding";
import { isOwnerOrAdmin } from "../domain/roles";

export interface OnboardingStore {
  /** Counts for one organization. Every query filters by it. */
  facts(organizationId: string): Promise<OnboardingFacts>;
  isDismissed(organizationId: string): Promise<boolean>;
  dismiss(organizationId: string, userId: string): Promise<void>;
}

export interface OnboardingDeps {
  store: OnboardingStore;
}

export interface OnboardingView extends OnboardingChecklist {
  dismissed: boolean;
  canDismiss: boolean;
}

/** Any member can read the checklist: it holds counts and no secrets. */
export async function getOnboarding(deps: OnboardingDeps, actor: Actor): Promise<OnboardingView> {
  const [facts, dismissed] = await Promise.all([deps.store.facts(actor.organizationId), deps.store.isDismissed(actor.organizationId)]);
  return { ...deriveChecklist(facts), dismissed, canDismiss: isOwnerOrAdmin(actor.role) };
}

/** Hides the setup prompts for the whole organization. The page itself stays reachable. */
export async function dismissOnboarding(deps: OnboardingDeps, actor: Actor): Promise<void> {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can dismiss the setup guide.");
  await deps.store.dismiss(actor.organizationId, actor.userId);
}
