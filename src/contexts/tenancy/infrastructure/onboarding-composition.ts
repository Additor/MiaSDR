import type { OnboardingDeps } from "../application/onboarding";
import type { SetupDeps } from "../application/setup-instance";
import { drizzleOnboardingStore } from "./drizzle-onboarding-store";
import { drizzleSetupStore } from "./drizzle-setup-store";

export const onboardingDeps = (): OnboardingDeps => ({ store: drizzleOnboardingStore });

/** First-run setup store. The setup route adds its own password hasher. */
export const setupDeps = (): Pick<SetupDeps, "store"> => ({ store: drizzleSetupStore });
