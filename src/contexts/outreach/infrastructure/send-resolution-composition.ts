import type { SendResolutionDeps } from "../application/send-resolution";
import { drizzleLinkedInSendResolutionStore } from "../linkedin/infrastructure/drizzle-linkedin-store";
import { drizzleSendResolutionStore } from "./drizzle-management-stores";

export const sendResolutionDeps = (): SendResolutionDeps => ({ sends: drizzleSendResolutionStore, now: () => new Date() });

export const linkedinSendResolutionDeps = (): SendResolutionDeps => ({ sends: drizzleLinkedInSendResolutionStore, now: () => new Date() });
