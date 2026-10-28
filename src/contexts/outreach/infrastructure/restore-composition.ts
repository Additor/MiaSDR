import type { EnrollmentRestoreDeps } from "../application/enrollment-restore";
import type { PersonTimeline } from "../application/inbound-ports";
import { createEnrollmentRestoreStore } from "./drizzle-enrollment-restore";

/** Restore of removed leads. src/composition passes conversations' person timeline. */
export const enrollmentRestoreDeps = (timeline: PersonTimeline): EnrollmentRestoreDeps => ({ restore: createEnrollmentRestoreStore(timeline) });
