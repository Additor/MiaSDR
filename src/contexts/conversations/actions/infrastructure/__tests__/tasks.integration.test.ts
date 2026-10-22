import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("tasks, note ownership and the important flag", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  let composition: typeof import("../../../infrastructure/composition");
  let tasks: typeof import("../../application/tasks");
  let replies: typeof import("../../../application/reply-handling");
  let deps: import("../../application/tasks").TaskDeps;
  let replyHandlingDeps: import("../../../application/reply-handling").ReplyHandlingDeps;
  const orgs: string[] = [];
  const users: string[] = [];
  let counter = 0;

  async function user(label: string) {
    const [{ id }] = await sql`insert into users (name, email) values (${label}, ${`${label}-${uniqueKey()}@x.test`}) returning id`;
    users.push(id);
    return id as string;
  }

  async function org() {
    const tag = uniqueKey();
    const [{ id }] = await sql`insert into organizations (name, slug) values ('Tasks', ${"tsk-" + tag}) returning id`;
    orgs.push(id);
    const member = async (label: string, role: string): Promise<Actor> => {
      const userId = await user(label);
      await sql`insert into members (organization_id, user_id, role) values (${id}, ${userId}, ${role})`;
      return { userId, organizationId: id, role };
    };
    const [admin, ann, bob] = [await member("admin", "admin"), await member("ann", "member"), await member("bob", "member")];
    const mailbox = `me-${tag}@corp.test`;
    const n = ++counter;
    const result = await composition.ingestInbound({
      organizationId: id,
      accountRef: mailbox,
      providerThreadId: `thread-${n}`,
      providerMessageId: `msg-${n}`,
      rfcMessageId: `<t${n}@lead.test>`,
      inReplyTo: null,
      from: { email: `lead${n}-${tag}@acme.test`, name: "Lena Lead" },
      to: [mailbox],
      subject: "Re: hello",
      bodyText: "Call me next week",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      autoReply: false,
    });
    const [record] = await sql`select id from records where person_id = ${result.personId}`;
    return { id, admin, ann, bob, recordId: record.id as string, messageId: result.messageId, conversationId: result.conversationId };
  }

  beforeAll(async () => {
    composition = await import("../../../infrastructure/composition");
    tasks = await import("../../application/tasks");
    replies = await import("../../../application/reply-handling");
    deps = (await import("../task-composition")).taskDeps();
    replyHandlingDeps = (await import("../../../infrastructure/reply-handling-composition")).replyHandlingDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("creates a task for the record's person, assigned and due at the end of the local day", async () => {
    const w = await org();
    const { id } = await tasks.createTask(deps, w.ann, w.recordId, { name: " Call Lena ", dueDay: "2026-10-20", timeZone: "Asia/Seoul", assigneeId: w.bob.userId });
    const [row] = await sql`select * from tasks where id = ${id}`;
    expect(row).toMatchObject({ name: "Call Lena", assigned_to: w.bob.userId, created_by: w.ann.userId, is_completed: false });
    expect(new Date(row.due_at).toISOString()).toBe("2026-10-20T14:59:59.000Z");
    const [record] = await sql`select person_id from records where id = ${w.recordId}`;
    expect(row.person_id).toBe(record.person_id);
  });

  it("rejects an assignee from another organization and a record from another organization", async () => {
    const a = await org();
    const b = await org();
    await expect(tasks.createTask(deps, a.ann, a.recordId, { name: "x", assigneeId: b.ann.userId })).rejects.toBeInstanceOf(ValidationError);
    await expect(tasks.createTask(deps, a.ann, b.recordId, { name: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lets a member change tasks they created or hold and keeps others out; an admin changes any", async () => {
    const w = await org();
    const { id } = await tasks.createTask(deps, w.ann, w.recordId, { name: "Mine", assigneeId: w.ann.userId });
    await expect(tasks.setTaskCompleted(deps, w.bob, id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tasks.deleteTask(deps, w.bob, id)).rejects.toBeInstanceOf(ForbiddenError);
    await tasks.updateTask(deps, w.ann, id, { assigneeId: w.bob.userId });
    // Bob holds it now and may complete it; Ann created it and may still reopen it.
    await tasks.setTaskCompleted(deps, w.bob, id, true);
    const [done] = await sql`select is_completed, completed_by, completed_at from tasks where id = ${id}`;
    expect(done.is_completed).toBe(true);
    expect(done.completed_by).toBe(w.bob.userId);
    expect(done.completed_at).not.toBeNull();
    await tasks.setTaskCompleted(deps, w.admin, id, false);
    const [open] = await sql`select is_completed, completed_by, completed_at from tasks where id = ${id}`;
    expect(open).toMatchObject({ is_completed: false, completed_by: null, completed_at: null });
    await tasks.deleteTask(deps, w.admin, id);
    expect((await sql`select 1 from tasks where id = ${id}`).length).toBe(0);
  });

  it("answers 404 for another organization's task", async () => {
    const a = await org();
    const b = await org();
    const { id } = await tasks.createTask(deps, a.ann, a.recordId, { name: "Private" });
    await expect(tasks.setTaskCompleted(deps, b.admin, id, true)).rejects.toBeInstanceOf(NotFoundError);
    await expect(tasks.deleteTask(deps, b.admin, id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await tasks.listTasks(deps, b.admin, { state: "all" })).toEqual([]);
  });

  it("lists open tasks overdue first, completed last, and filters by assignee and state", async () => {
    const w = await org();
    const late = (await tasks.createTask(deps, w.ann, w.recordId, { name: "late", dueDay: "2026-01-02", assigneeId: w.ann.userId })).id;
    const soon = (await tasks.createTask(deps, w.ann, w.recordId, { name: "soon", dueDay: "2026-12-01", assigneeId: w.bob.userId })).id;
    const none = (await tasks.createTask(deps, w.ann, w.recordId, { name: "none", assigneeId: w.ann.userId })).id;
    const done = (await tasks.createTask(deps, w.ann, w.recordId, { name: "done", dueDay: "2026-01-01", assigneeId: w.ann.userId })).id;
    await tasks.setTaskCompleted(deps, w.ann, done, true);
    expect((await tasks.listTasks(deps, w.ann, { state: "all" })).map((t) => t.id)).toEqual([late, soon, none, done]);
    expect((await tasks.listTasks(deps, w.ann, { state: "open" })).map((t) => t.id)).toEqual([late, soon, none]);
    expect((await tasks.listTasks(deps, w.ann, { state: "open", mine: true })).map((t) => t.id)).toEqual([late, none]);
    expect((await tasks.listTasks(deps, w.ann, { state: "completed" })).map((t) => t.id)).toEqual([done]);
    expect((await tasks.listTasks(deps, w.ann, { state: "all", recordId: w.recordId })).length).toBe(4);
  });

  it("clears a due date and reassigns to nobody", async () => {
    const w = await org();
    const { id } = await tasks.createTask(deps, w.ann, w.recordId, { name: "t", dueDay: "2026-10-20", assigneeId: w.ann.userId });
    await tasks.updateTask(deps, w.ann, id, { dueDay: null, assigneeId: null });
    const [row] = await sql`select due_at, assigned_to from tasks where id = ${id}`;
    expect(row).toMatchObject({ due_at: null, assigned_to: null });
  });

  it("limits note edits and deletes to the author or an admin", async () => {
    const w = await org();
    const { id } = await replies.addRecordNote(replyHandlingDeps, w.ann, w.recordId, { body: "first" });
    await expect(tasks.editNote(deps, w.bob, w.recordId, id, { body: "hijack" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tasks.assertCanDeleteNote(deps, w.bob, w.recordId, id)).rejects.toBeInstanceOf(ForbiddenError);
    await tasks.editNote(deps, w.ann, w.recordId, id, { title: " T ", body: " second " });
    const [row] = await sql`select title, body from notes where id = ${id}`;
    expect(row).toEqual({ title: "T", body: "second" });
    await tasks.editNote(deps, w.admin, w.recordId, id, { body: "admin edit" });
    await tasks.assertCanDeleteNote(deps, w.admin, w.recordId, id);
    await expect(tasks.editNote(deps, w.ann, w.recordId, id, { body: "  " })).rejects.toBeInstanceOf(ValidationError);
  });

  async function personWithoutRecord(organizationId: string) {
    const [{ id }] = await sql`insert into people (organization_id, email, full_name) values (${organizationId}, ${`norec-${uniqueKey()}@acme.test`}, 'Nora Norecord') returning id`;
    expect((await sql`select 1 from records where person_id = ${id}`).length).toBe(0);
    return id as string;
  }

  it("adds, edits and deletes a note on a person with no reply record, stored with a null record_id", async () => {
    const w = await org();
    const personId = await personWithoutRecord(w.id);
    const { id } = await replies.addRecordNote(replyHandlingDeps, w.ann, { personId }, { title: " Call ", body: " Wants pricing " });
    const [row] = await sql`select person_id, record_id, title, body, created_by from notes where id = ${id}`;
    expect(row).toEqual({ person_id: personId, record_id: null, title: "Call", body: "Wants pricing", created_by: w.ann.userId });

    await expect(tasks.editNote(deps, w.bob, { personId }, id, { body: "hijack" })).rejects.toBeInstanceOf(ForbiddenError);
    await tasks.editNote(deps, w.ann, { personId }, id, { body: " edited " });
    expect((await sql`select body, record_id from notes where id = ${id}`)[0]).toEqual({ body: "edited", record_id: null });

    const listed = await tasks.listPersonNotes(deps, w.ann, personId);
    expect(listed.map((n) => [n.id, n.recordId, n.authorName])).toEqual([[id, null, "ann"]]);

    await expect(tasks.assertCanDeleteNote(deps, w.bob, { personId }, id)).rejects.toBeInstanceOf(ForbiddenError);
    await tasks.assertCanDeleteNote(deps, w.ann, { personId }, id);
    await replies.deleteRecordNote(replyHandlingDeps, w.ann, { personId }, id);
    expect((await sql`select 1 from notes where id = ${id}`).length).toBe(0);
    await expect(replies.deleteRecordNote(replyHandlingDeps, w.ann, { personId }, id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("adds and completes a task on a person with no reply record, stored with a null record_id", async () => {
    const w = await org();
    const personId = await personWithoutRecord(w.id);
    const { id } = await tasks.createTask(deps, w.ann, { personId }, { name: "Send the deck", dueDay: "2026-10-20", timeZone: "UTC", assigneeId: w.bob.userId });
    const [row] = await sql`select person_id, record_id, assigned_to from tasks where id = ${id}`;
    expect(row).toEqual({ person_id: personId, record_id: null, assigned_to: w.bob.userId });
    await tasks.setTaskCompleted(deps, w.bob, id, true);
    expect((await sql`select is_completed from tasks where id = ${id}`)[0].is_completed).toBe(true);
    expect((await tasks.listTasks(deps, w.ann, { state: "all", personId })).map((t) => [t.id, t.recordId, t.isCompleted])).toEqual([[id, null, true]]);
  });

  it("lists by person every note and task, record-bound ones included, and edits a record-bound note through the person", async () => {
    const w = await org();
    const [{ person_id: personId }] = await sql`select person_id from records where id = ${w.recordId}`;
    const onRecord = await replies.addRecordNote(replyHandlingDeps, w.ann, w.recordId, { body: "on the record" });
    const onPerson = await replies.addRecordNote(replyHandlingDeps, w.ann, { personId }, { body: "on the person" });
    expect((await tasks.listPersonNotes(deps, w.ann, personId)).map((n) => n.id).sort()).toEqual([onRecord.id, onPerson.id].sort());
    // The record scope still finds only the record's own notes.
    await expect(tasks.editNote(deps, w.ann, w.recordId, onPerson.id, { body: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await tasks.editNote(deps, w.ann, { personId }, onRecord.id, { body: "edited through the person" });
    expect((await sql`select body, record_id from notes where id = ${onRecord.id}`)[0]).toEqual({ body: "edited through the person", record_id: w.recordId });

    const recordTask = await tasks.createTask(deps, w.ann, w.recordId, { name: "record task" });
    const personTask = await tasks.createTask(deps, w.ann, { personId }, { name: "person task" });
    expect((await tasks.listTasks(deps, w.ann, { state: "all", personId })).map((t) => t.id).sort()).toEqual([recordTask.id, personTask.id].sort());
    expect((await tasks.listTasks(deps, w.ann, { state: "all", recordId: w.recordId })).map((t) => t.id)).toEqual([recordTask.id]);
  });

  it("leaves a note out of the person's list when its record has only private threads", async () => {
    const w = await org();
    const [{ person_id: personId }] = await sql`select person_id from records where id = ${w.recordId}`;
    const onRecord = await replies.addRecordNote(replyHandlingDeps, w.ann, w.recordId, { body: "on the record" });
    const onPerson = await replies.addRecordNote(replyHandlingDeps, w.ann, { personId }, { body: "on the person" });
    const [{ id: campaignId }] = await sql`insert into campaigns (organization_id, name, channel, type) values (${w.id}, 'Personal', 'linkedin', 'personal') returning id`;
    await sql`update conversations set private_campaign_id = ${campaignId} where id = ${w.conversationId}`;
    expect((await tasks.listPersonNotes(deps, w.ann, personId)).map((n) => n.id)).toEqual([onPerson.id]);
    await sql`update conversations set private_campaign_id = null where id = ${w.conversationId}`;
    await sql`delete from campaigns where id = ${campaignId}`;
    expect((await tasks.listPersonNotes(deps, w.ann, personId)).map((n) => n.id).sort()).toEqual([onRecord.id, onPerson.id].sort());
  });

  it("does not find a note or task of a private-thread-only record through the person; the record scope still does", async () => {
    const w = await org();
    const [{ person_id: personId }] = await sql`select person_id from records where id = ${w.recordId}`;
    const onRecord = await replies.addRecordNote(replyHandlingDeps, w.ann, w.recordId, { body: "on the record" });
    const recordTask = await tasks.createTask(deps, w.ann, w.recordId, { name: "record task" });
    const personTask = await tasks.createTask(deps, w.ann, { personId }, { name: "person task" });
    const [{ id: campaignId }] = await sql`insert into campaigns (organization_id, name, channel, type) values (${w.id}, 'Personal', 'linkedin', 'personal') returning id`;
    await sql`update conversations set private_campaign_id = ${campaignId} where id = ${w.conversationId}`;
    try {
      await expect(tasks.editNote(deps, w.ann, { personId }, onRecord.id, { body: "x" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(tasks.assertCanDeleteNote(deps, w.admin, { personId }, onRecord.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(replies.deleteRecordNote(replyHandlingDeps, w.admin, { personId }, onRecord.id)).rejects.toBeInstanceOf(NotFoundError);
      expect((await sql`select body from notes where id = ${onRecord.id}`)[0].body).toBe("on the record");
      expect((await tasks.listTasks(deps, w.ann, { state: "all", personId })).map((t) => t.id)).toEqual([personTask.id]);
      // The private thread's own view, by record, keeps both.
      await tasks.editNote(deps, w.ann, w.recordId, onRecord.id, { body: "edited on the record" });
      expect((await tasks.listTasks(deps, w.ann, { state: "all", recordId: w.recordId })).map((t) => t.id)).toEqual([recordTask.id]);
    } finally {
      await sql`update conversations set private_campaign_id = null where id = ${w.conversationId}`;
      await sql`delete from campaigns where id = ${campaignId}`;
    }
  });

  it("answers 404 for another organization's person in every person-scoped call", async () => {
    const a = await org();
    const b = await org();
    const personId = await personWithoutRecord(a.id);
    const note = await replies.addRecordNote(replyHandlingDeps, a.ann, { personId }, { body: "private" });
    await expect(replies.addRecordNote(replyHandlingDeps, b.ann, { personId }, { body: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(tasks.createTask(deps, b.ann, { personId }, { name: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(tasks.listTasks(deps, b.ann, { personId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(tasks.listPersonNotes(deps, b.ann, personId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(tasks.editNote(deps, b.admin, { personId }, note.id, { body: "x" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(tasks.assertCanDeleteNote(deps, b.admin, { personId }, note.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(replies.deleteRecordNote(replyHandlingDeps, b.admin, { personId }, note.id)).rejects.toBeInstanceOf(NotFoundError);
    // Another person of the same organization does not reach the note either.
    const other = await personWithoutRecord(a.id);
    await expect(tasks.editNote(deps, a.ann, { personId: other }, note.id, { body: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("stars a message, shows it in the Important view and unstars it", async () => {
    const w = await org();
    const other = await org();
    const inbox = (await import("../../../infrastructure/composition")).inboxDeps();
    const { listInbox, getThread } = await import("../../../application/inbox");
    expect((await listInbox(inbox, w.ann, { view: "important" })).total).toBe(0);
    await expect(tasks.setMessageImportant(deps, other.ann, w.messageId, true)).rejects.toBeInstanceOf(NotFoundError);
    await tasks.setMessageImportant(deps, w.ann, w.messageId, true);
    const listed = await listInbox(inbox, w.ann, { view: "important" });
    expect(listed.total).toBe(1);
    expect(listed.rows[0]).toMatchObject({ conversationId: w.conversationId, hasImportant: true });
    expect((await listInbox(inbox, other.ann, { view: "important" })).total).toBe(0);
    const thread = await getThread(inbox, w.ann, w.conversationId);
    expect(thread.recordId).toBe(w.recordId);
    expect(thread.messages.find((m) => m.id === w.messageId)?.important).toBe(true);
    await tasks.setMessageImportant(deps, w.ann, w.messageId, false);
    expect((await listInbox(inbox, w.ann, { view: "important" })).total).toBe(0);
  });
});
