import type { AssignmentDeps } from "../application/assignment";
import { drizzleAssignmentStore } from "./drizzle-assignment-store";

/** Wires the assignment use cases. They write the assignee and one event; they send nothing. */
export const assignmentDeps = (): AssignmentDeps => ({ store: drizzleAssignmentStore, now: () => new Date() });
