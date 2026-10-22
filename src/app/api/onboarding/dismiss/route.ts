import { dismissOnboarding } from "@/contexts/tenancy/application/onboarding";
import { onboardingDeps } from "@/contexts/tenancy/infrastructure/onboarding-composition";
import { withActor } from "@/app/_lib/api";

export const POST = () => withActor(async (actor) => dismissOnboarding(onboardingDeps(), actor));
