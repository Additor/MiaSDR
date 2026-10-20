import type { WorkQueueDeps } from "../application/work-queue";
import { organizationTimeZone } from "../../infrastructure/org-time-zone";
import { drizzleWorkQueueStore } from "./work-queue-read";

/** Wires the work queue use cases. They read only: no mailer, no writes. */
export const workQueueDeps = (): WorkQueueDeps => ({ store: drizzleWorkQueueStore, timeZone: organizationTimeZone });
