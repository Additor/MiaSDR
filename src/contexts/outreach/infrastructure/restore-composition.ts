import type { EnrollmentRestoreDeps } from "../application/enrollment-restore";
import { drizzleEnrollmentRestoreStore } from "./drizzle-enrollment-restore";

export const enrollmentRestoreDeps = (): EnrollmentRestoreDeps => ({ restore: drizzleEnrollmentRestoreStore });
