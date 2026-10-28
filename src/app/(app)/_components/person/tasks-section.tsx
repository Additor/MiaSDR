import { connection } from "next/server";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { canChangeTask } from "@/contexts/conversations/actions/domain/tasks";
import { listTasks } from "@/contexts/conversations/actions/application/tasks";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import type { Actor } from "@/shared/errors";
import { TasksPanel, type TaskTarget } from "./tasks-panel";
import { listMemberChoices } from "@/contexts/tenancy/application/member-directory";
import { memberDirectoryDeps } from "@/contexts/tenancy/infrastructure/member-composition";

/**
 * Loads the tasks and the organization's members. With `recordId`, one reply record's tasks; with `personId`, every task of
 * the person, and new tasks get no record. Wrap it in Suspense.
 */
export async function TasksSection({ actor, compact, ...target }: TaskTarget & { actor: Actor; compact?: boolean }) {
  await connection();
  const deps = taskDeps();
  const scope = target.recordId !== undefined ? { recordId: target.recordId } : { personId: target.personId };
  const [tasks, members] = await Promise.all([listTasks(deps, actor, { state: "all", ...scope }), listMemberChoices(memberDirectoryDeps(), actor)]);
  const admin = isOwnerOrAdmin(actor.role);
  return (
    <TasksPanel
      {...target}
      compact={compact}
      currentUserId={actor.userId}
      nowMs={deps.now().getTime()}
      members={members}
      tasks={tasks.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        isCompleted: t.isCompleted,
        dueAt: t.dueAt?.toISOString() ?? null,
        assigneeId: t.assigneeId,
        assigneeName: t.assigneeName,
        canChange: canChangeTask(actor, admin, t),
      }))}
    />
  );
}
