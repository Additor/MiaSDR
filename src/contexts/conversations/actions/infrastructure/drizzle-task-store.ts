import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { conversations, messages, notes, people, records, tasks, users } from "@/platform/db/schema";
import { onVisibleRecordSql, publicConversation, publicConversationSql } from "@/platform/db/conversation-visibility";
import type { NoteScope, TaskRow, TaskStore } from "../application/tasks-ports";

const assignee = users;

const columns = {
  id: tasks.id,
  recordId: tasks.recordId,
  personId: tasks.personId,
  personName: sql<string | null>`coalesce(${people.fullName}, ${people.firstName}, ${people.email})`,
  personLifecycle: people.lifecycle,
  // The same pick as `activeConversationOfPerson`: public threads only, the record's active channel first.
  conversationId: sql<string | null>`(
    select c.id from conversations c join records r on r.id = c.record_id and r.organization_id = c.organization_id
    where r.person_id = ${tasks.personId} and r.organization_id = ${tasks.organizationId} and ${publicConversationSql("c")}
    order by (c.channel = r.active_channel) desc nulls last, c.updated_at desc, c.id limit 1)`,
  name: tasks.name,
  description: tasks.description,
  isCompleted: tasks.isCompleted,
  dueAt: tasks.dueAt,
  createdBy: tasks.createdBy,
  assigneeId: tasks.assignedTo,
  assigneeName: assignee.name,
  completedAt: tasks.completedAt,
  createdAt: tasks.createdAt,
};

/**
 * A record scope matches that record's rows; a person scope matches the person's rows that `personNotes` lists, so a note on a
 * private-thread-only record is not found through the person.
 */
const noteScopeWhere = (scope: NoteScope) =>
  scope.recordId !== undefined ? eq(notes.recordId, scope.recordId) : and(eq(notes.personId, scope.personId), onVisibleRecordSql(notes.recordId));

function select(where: SQL | undefined) {
  return db
    .select(columns)
    .from(tasks)
    .innerJoin(people, and(eq(people.id, tasks.personId), eq(people.organizationId, tasks.organizationId)))
    .leftJoin(assignee, eq(assignee.id, tasks.assignedTo))
    .where(where);
}

export const drizzleTaskStore: TaskStore = {
  async list(organizationId, filter) {
    const where = and(
      eq(tasks.organizationId, organizationId),
      filter.state === "open" ? eq(tasks.isCompleted, false) : filter.state === "completed" ? eq(tasks.isCompleted, true) : undefined,
      filter.assigneeId ? eq(tasks.assignedTo, filter.assigneeId) : undefined,
      filter.recordId ? eq(tasks.recordId, filter.recordId) : undefined,
      // Through the person, a task on a record whose only threads are private stays with that private thread, as notes do.
      filter.personId ? and(eq(tasks.personId, filter.personId), onVisibleRecordSql(tasks.recordId)) : undefined,
    );
    const rows: TaskRow[] = await select(where)
      .orderBy(asc(tasks.isCompleted), sql`${tasks.dueAt} asc nulls last`, asc(tasks.createdAt), asc(tasks.id))
      .limit(filter.limit);
    return rows;
  },

  async recordExists(organizationId, recordId) {
    const [row] = await db.select({ id: records.id }).from(records).where(and(eq(records.id, recordId), eq(records.organizationId, organizationId)));
    return Boolean(row);
  },

  async personExists(organizationId, personId) {
    const [row] = await db.select({ id: people.id }).from(people).where(and(eq(people.id, personId), eq(people.organizationId, organizationId)));
    return Boolean(row);
  },

  async get(organizationId, taskId) {
    const [row] = await select(and(eq(tasks.organizationId, organizationId), eq(tasks.id, taskId)));
    return row ?? null;
  },

  async create(input) {
    const { scope } = input;
    const [owner] =
      scope.recordId !== undefined
        ? await db
            .select({ recordId: records.id, personId: records.personId })
            .from(records)
            .where(and(eq(records.id, scope.recordId), eq(records.organizationId, input.organizationId)))
        : await db
            .select({ recordId: sql<string | null>`null::uuid`, personId: people.id })
            .from(people)
            .where(and(eq(people.id, scope.personId), eq(people.organizationId, input.organizationId)));
    if (!owner) return null;
    const [row] = await db
      .insert(tasks)
      .values({
        organizationId: input.organizationId,
        personId: owner.personId,
        recordId: owner.recordId,
        name: input.name,
        description: input.description,
        dueAt: input.dueAt,
        assignedTo: input.assigneeId,
        createdBy: input.actorUserId,
      })
      .returning({ id: tasks.id });
    return row;
  },

  async update({ organizationId, taskId, patch }) {
    const set: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
    if (patch.assigneeId !== undefined) set.assignedTo = patch.assigneeId;
    const rows = await db.update(tasks).set(set).where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId))).returning({ id: tasks.id });
    return rows.length > 0;
  },

  async setCompleted({ organizationId, taskId, actorUserId, completed, now }) {
    const rows = await db
      .update(tasks)
      .set({ isCompleted: completed, completedAt: completed ? now : null, completedBy: completed ? actorUserId : null, updatedAt: now })
      .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId)))
      .returning({ id: tasks.id });
    return rows.length > 0;
  },

  async delete(organizationId, taskId) {
    const rows = await db.delete(tasks).where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId))).returning({ id: tasks.id });
    return rows.length > 0;
  },

  async getNote(organizationId, scope, noteId) {
    const [row] = await db
      .select({ id: notes.id, createdBy: notes.createdBy })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.organizationId, organizationId), noteScopeWhere(scope)));
    return row ?? null;
  },

  async updateNote({ organizationId, scope, noteId, title, body }) {
    const rows = await db
      .update(notes)
      .set({ title, body, updatedAt: new Date() })
      .where(and(eq(notes.id, noteId), eq(notes.organizationId, organizationId), noteScopeWhere(scope)))
      .returning({ id: notes.id });
    return rows.length > 0;
  },

  async personNotes(organizationId, personId) {
    return db
      .select({ id: notes.id, recordId: notes.recordId, title: notes.title, body: notes.body, createdAt: notes.createdAt, authorName: users.name, createdBy: notes.createdBy })
      .from(notes)
      .leftJoin(users, eq(users.id, notes.createdBy))
      .where(
        and(
          eq(notes.organizationId, organizationId),
          eq(notes.personId, personId),
          onVisibleRecordSql(notes.recordId),
        ),
      )
      .orderBy(desc(notes.createdAt), desc(notes.id));
  },

  async setMessageImportant(organizationId, messageId, important) {
    const rows = await db
      .update(messages)
      .set({ important })
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.organizationId, organizationId),
          // A message of a private conversation is not found, like every other reader of it.
          inArray(messages.conversationId, db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.organizationId, organizationId), publicConversation))),
        ),
      )
      .returning({ id: messages.id });
    return rows.length > 0;
  },
};
