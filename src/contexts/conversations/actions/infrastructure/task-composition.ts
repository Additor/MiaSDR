import type { TaskDeps } from "../application/tasks";
import { drizzleTaskStore } from "./drizzle-task-store";

export const taskDeps = (): TaskDeps => ({ store: drizzleTaskStore, now: () => new Date() });
