import { dismissOnboarding } from "@/contexts/tenancy/application/onboarding";
import { onboardingDeps } from "@/composition/onboarding";
import { withActor } from "@/app/_lib/api";

export const POST = () => withActor(async (actor) => dismissOnboarding(onboardingDeps(), actor));
