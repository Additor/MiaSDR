import { z } from "zod";
import { createTask, listTasks, setTaskCompleted, updateTask } from "@/contexts/conversations/actions/application/tasks";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { getOrganization } from "@/contexts/tenancy/application/organization-settings";
import { organizationDeps } from "@/contexts/tenancy/infrastructure/organization-composition";
import { ValidationError, type Actor } from "@/shared/errors";
import { CHANGES, defineTool, need } from "./define";
import { DEFAULT_LIST_LIMIT, fitItems, iso, listLimit } from "./output";

const ACTIONS = ["list", "create", "update", "complete"] as const;

const task = z.object({
  taskId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isCompleted: z.boolean(),
  dueAt: z.string().nullable(),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  conversationId: z.string().nullable(),
  personId: z.string(),
  personName: z.string().nullable(),
});

/** A due day falls at the end of that day in the organization's zone unless the call names another. */
async function zoneFor(actor: Actor, asked: string | undefined): Promise<string> {
  return asked ?? (await getOrganization(organizationDeps(), actor)).timeZone;
}

export const manageTaskTool = defineTool({
  name: "manage_task",
  title: "Manage tasks",
  description: [
    "Lists and changes tasks, as on the Actions page. `list` filters by `conversationId`, `personId`, `state` (open, completed, all) and `mine`;",
    "`create` adds one on a reply handling (`conversationId`) or a person (`personId`) with `name`, optional `description`, `dueDay` (YYYY-MM-DD, ends in the organization's time zone unless `timeZone`) and `assigneeId`;",
    "`update` changes those fields (`taskId`); `complete` sets `completed` (`taskId`). A member changes tasks they created or hold.",
  ].join(" "),
  scope: "mcp:write",
  annotations: CHANGES,
  input: z.object({
    action: z.enum(ACTIONS),
    taskId: z.string().optional(),
    conversationId: z.string().optional(),
    personId: z.string().optional(),
    state: z.enum(["open", "completed", "all"]).optional(),
    mine: z.boolean().optional(),
    limit: z.number().int().optional(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    dueDay: z.string().nullable().optional(),
    timeZone: z.string().optional(),
    assigneeId: z.string().nullable().optional(),
    completed: z.boolean().optional(),
  }),
  output: z.object({ action: z.enum(ACTIONS), taskId: z.string().nullable(), tasks: z.array(task), omitted: z.number() }),
  // Listing changes nothing, so it counts as a read only.
  buckets: (input) => (input.action === "list" ? [] : ["write"]),
  async run({ actor }, input) {
    switch (input.action) {
      case "list": {
        const rows = await listTasks(taskDeps(), actor, { conversationId: input.conversationId, personId: input.personId, state: input.state, mine: input.mine });
        const limited = rows.slice(0, listLimit(input.limit, DEFAULT_LIST_LIMIT));
        const { items, omitted } = fitItems(
          limited.map((t) => ({
            taskId: t.id,
            name: t.name,
            description: t.description,
            isCompleted: t.isCompleted,
            dueAt: iso(t.dueAt),
            assigneeId: t.assigneeId,
            assigneeName: t.assigneeName,
            conversationId: t.conversationId,
            personId: t.personId,
            personName: t.personName,
          })),
        );
        const more = omitted + rows.length - limited.length;
        return { summary: `${items.length} task(s)${more > 0 ? `, ${more} more not shown` : ""}.`, structured: { action: input.action, taskId: null, tasks: items, omitted: more } };
      }
      case "create": {
        if (input.conversationId && input.personId) throw new ValidationError("Pass conversationId or personId, not both.");
        const target = input.conversationId ?? (input.personId ? { personId: input.personId } : undefined);
        if (!target) throw new ValidationError("create needs conversationId or personId.");
        const created = await createTask(taskDeps(), actor, target, {
          name: need(input.name, "name", "create"),
          description: input.description,
          dueDay: input.dueDay,
          timeZone: input.dueDay ? await zoneFor(actor, input.timeZone) : null,
          assigneeId: input.assigneeId,
        });
        return { summary: `Created task ${created.id}.`, structured: { action: input.action, taskId: created.id, tasks: [], omitted: 0 } };
      }
      case "update": {
        const taskId = need(input.taskId, "taskId", "update");
        await updateTask(taskDeps(), actor, taskId, {
          name: input.name,
          description: input.description,
          dueDay: input.dueDay,
          timeZone: input.dueDay ? await zoneFor(actor, input.timeZone) : undefined,
          assigneeId: input.assigneeId,
        });
        return { summary: "Updated the task.", structured: { action: input.action, taskId, tasks: [], omitted: 0 } };
      }
      case "complete": {
        const taskId = need(input.taskId, "taskId", "complete");
        const completed = need(input.completed, "completed", "complete");
        await setTaskCompleted(taskDeps(), actor, taskId, completed);
        return { summary: completed ? "Marked the task done." : "Marked the task open.", structured: { action: input.action, taskId, tasks: [], omitted: 0 } };
      }
    }
  },
});
