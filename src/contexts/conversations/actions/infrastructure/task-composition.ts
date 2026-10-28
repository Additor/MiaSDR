import type { TaskDeps } from "../application/tasks";
import { drizzleMemberDirectory } from "@/contexts/tenancy/infrastructure/drizzle-member-directory";
import { drizzleTaskStore } from "./drizzle-task-store";

export const taskDeps = (): TaskDeps => ({ store: drizzleTaskStore, members: drizzleMemberDirectory, now: () => new Date() });
