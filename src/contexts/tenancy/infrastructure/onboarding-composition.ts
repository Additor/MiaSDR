import type { SetupDeps } from "../application/setup-instance";
import { drizzleSetupStore } from "./drizzle-setup-store";

// The onboarding checklist reads AI setup from integrations, so its wiring lives in src/composition/onboarding.ts.

/** First-run setup store. The setup route adds its own password hasher. */
export const setupDeps = (): Pick<SetupDeps, "store"> => ({ store: drizzleSetupStore });
