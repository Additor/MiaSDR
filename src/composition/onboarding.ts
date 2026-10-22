import { aiStatus } from "@/contexts/integrations/infrastructure/composition";
import type { OnboardingDeps } from "@/contexts/tenancy/application/onboarding";
import type { AiSetup } from "@/contexts/tenancy/domain/onboarding";
import { drizzleOnboardingStore } from "@/contexts/tenancy/infrastructure/drizzle-onboarding-store";

/*
 * The onboarding checklist's wiring. Tenancy sits below integrations, so the AI step's state comes in through this
 * port: the same status the AI model card, the Inbox and AI columns read.
 */

async function aiSetup(organizationId: string): Promise<AiSetup> {
  const status = await aiStatus(organizationId);
  if (status.state === "on") return { state: "on", running: `${status.provider}, ${status.model}` };
  if (status.state === "demo") return { state: "on", running: "Demo mode" };
  if (status.state === "no_model") return { state: "needs_model", provider: status.provider };
  return { state: "none" };
}

export const onboardingDeps = (): OnboardingDeps => ({ store: drizzleOnboardingStore, aiSetup });
