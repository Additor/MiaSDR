import type { SendResolutionDeps } from "../application/send-resolution";
import { drizzleSendResolutionStore } from "./drizzle-management-stores";

export const sendResolutionDeps = (): SendResolutionDeps => ({ sends: drizzleSendResolutionStore, now: () => new Date() });
