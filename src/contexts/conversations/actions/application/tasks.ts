import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import {
  MAX_NOTE_BODY,
  MAX_NOTE_TITLE,
  canChangeNote,
  canChangeTask,
  endOfDayInZone,
  isValidTimeZone,
  parseTaskInput,
} from "../domain/tasks";
import type { NoteScope, TaskListFilter, TaskRow, TaskStore } from "./tasks-ports";

/**
 * Tasks and notes of a person, through a reply record or directly by person, notes ownership and the important flag. Any member may create tasks and
 * assign them to any member. A member changes the tasks they created or hold; owners and admins
 * change any task. Every store call carries the actor's organization.
 */

export interface TaskDeps {
  store: TaskStore;
  now: () => Date;
}

export const TASK_LIST_LIMIT = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assertId = (id: string, what: string) => {
  if (!UUID.test(id)) throw new NotFoundError(`${what} not found`);
};

/** A record id (the record routes) or a person scope (the person routes), checked for shape. */
export type NoteTarget = string | NoteScope;

export function noteScope(target: NoteTarget): NoteScope {
  if (typeof target === "string") {
    assertId(target, "Reply handling");
    return { recordId: target };
  }
  if (target.personId !== undefined) {
    assertId(target.personId, "Person");
    return { personId: target.personId };
  }
  assertId(target.recordId, "Reply handling");
  return { recordId: target.recordId };
}

const scopeMissing = (scope: NoteScope) => new NotFoundError(scope.recordId !== undefined ? "Reply handling not found" : "Person not found");

async function assertAssignee(deps: TaskDeps, actor: Actor, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  assertId(assigneeId, "Assignee");
  if (!(await deps.store.isMember(actor.organizationId, assigneeId))) throw new ValidationError("The assignee is not a member of this organization.");
}

async function loadChangeable(deps: TaskDeps, actor: Actor, taskId: string): Promise<TaskRow> {
  assertId(taskId, "Task");
  const task = await deps.store.get(actor.organizationId, taskId);
  if (!task) throw new NotFoundError("Task not found");
  if (!canChangeTask(actor, isOwnerOrAdmin(actor.role), task)) throw new ForbiddenError("Only the creator, the assignee or an admin can change this task.");
  return task;
}

export async function listTasks(deps: TaskDeps, actor: Actor, input: { state?: TaskListFilter["state"]; mine?: boolean; recordId?: string; personId?: string } = {}) {
  if (input.recordId) {
    assertId(input.recordId, "Reply handling");
    if (!(await deps.store.recordExists(actor.organizationId, input.recordId))) throw new NotFoundError("Reply handling not found");
  }
  if (input.personId) {
    assertId(input.personId, "Person");
    if (!(await deps.store.personExists(actor.organizationId, input.personId))) throw new NotFoundError("Person not found");
  }
  return deps.store.list(actor.organizationId, {
    state: input.state ?? "open",
    assigneeId: input.mine ? actor.userId : undefined,
    recordId: input.recordId,
    personId: input.personId,
    limit: TASK_LIST_LIMIT,
  });
}

/** A task on a record (`target` is its id) or on a person without one (`{ personId }`, stored with a null `record_id`). */
export async function createTask(
  deps: TaskDeps,
  actor: Actor,
  target: NoteTarget,
  input: { name: string; description?: string | null; dueDay?: string | null; timeZone?: string | null; assigneeId?: string | null },
) {
  const scope = noteScope(target);
  const parsed = parseTaskInput(input);
  await assertAssignee(deps, actor, input.assigneeId);
  const created = await deps.store.create({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    scope,
    name: parsed.name,
    description: parsed.description,
    dueAt: parsed.dueDay ? endOfDayInZone(parsed.dueDay, parsed.timeZone) : null,
    assigneeId: input.assigneeId ?? null,
  });
  if (!created) throw scopeMissing(scope);
  return created;
}

export async function updateTask(
  deps: TaskDeps,
  actor: Actor,
  taskId: string,
  input: { name?: string; description?: string | null; dueDay?: string | null; timeZone?: string | null; assigneeId?: string | null },
) {
  await loadChangeable(deps, actor, taskId);
  const patch: Parameters<TaskStore["update"]>[0]["patch"] = {};
  if (input.name !== undefined || input.description !== undefined) {
    const parsed = parseTaskInput({ name: input.name ?? "x", description: input.description });
    if (input.name !== undefined) patch.name = parsed.name;
    if (input.description !== undefined) patch.description = parsed.description;
  }
  if (input.dueDay !== undefined) {
    const zone = input.timeZone?.trim() || "UTC";
    if (!isValidTimeZone(zone)) throw new ValidationError("Unknown time zone.");
    patch.dueAt = input.dueDay ? endOfDayInZone(input.dueDay, zone) : null;
  }
  if (input.assigneeId !== undefined) {
    await assertAssignee(deps, actor, input.assigneeId);
    patch.assigneeId = input.assigneeId;
  }
  if (!(await deps.store.update({ organizationId: actor.organizationId, taskId, patch }))) throw new NotFoundError("Task not found");
}

export async function setTaskCompleted(deps: TaskDeps, actor: Actor, taskId: string, completed: boolean) {
  await loadChangeable(deps, actor, taskId);
  if (!(await deps.store.setCompleted({ organizationId: actor.organizationId, taskId, actorUserId: actor.userId, completed, now: deps.now() }))) {
    throw new NotFoundError("Task not found");
  }
}

export async function deleteTask(deps: TaskDeps, actor: Actor, taskId: string) {
  await loadChangeable(deps, actor, taskId);
  if (!(await deps.store.delete(actor.organizationId, taskId))) throw new NotFoundError("Task not found");
}

/** Edits a note found through its record (`target` is the record id) or through its person (`{ personId }`). */
export async function editNote(deps: TaskDeps, actor: Actor, target: NoteTarget, noteId: string, input: { title?: string | null; body: string }) {
  const scope = noteScope(target);
  assertId(noteId, "Note");
  const note = await deps.store.getNote(actor.organizationId, scope, noteId);
  if (!note) throw new NotFoundError("Note not found");
  if (!canChangeNote(actor, isOwnerOrAdmin(actor.role), note)) throw new ForbiddenError("Only the author or an admin can change this note.");
  const body = input.body.trim();
  if (body === "" || body.length > MAX_NOTE_BODY) throw new ValidationError(`The note must be 1 to ${MAX_NOTE_BODY} characters.`);
  const title = input.title?.trim() || null;
  if (title && title.length > MAX_NOTE_TITLE) throw new ValidationError(`The title is longer than ${MAX_NOTE_TITLE} characters.`);
  await deps.store.updateNote({ organizationId: actor.organizationId, scope, noteId, title, body });
}

/** Checks ownership of a note before `deleteRecordNote` removes it. */
export async function assertCanDeleteNote(deps: TaskDeps, actor: Actor, target: NoteTarget, noteId: string) {
  const scope = noteScope(target);
  assertId(noteId, "Note");
  const note = await deps.store.getNote(actor.organizationId, scope, noteId);
  if (!note) throw new NotFoundError("Note not found");
  if (!canChangeNote(actor, isOwnerOrAdmin(actor.role), note)) throw new ForbiddenError("Only the author or an admin can delete this note.");
}

/** Every note of the person, record-bound ones included, newest first. 404 for a person outside the organization. */
export async function listPersonNotes(deps: TaskDeps, actor: Actor, personId: string) {
  assertId(personId, "Person");
  if (!(await deps.store.personExists(actor.organizationId, personId))) throw new NotFoundError("Person not found");
  return deps.store.personNotes(actor.organizationId, personId);
}

export async function setMessageImportant(deps: TaskDeps, actor: Actor, messageId: string, important: boolean) {
  assertId(messageId, "Message");
  if (!(await deps.store.setMessageImportant(actor.organizationId, messageId, important))) throw new NotFoundError("Message not found");
}
