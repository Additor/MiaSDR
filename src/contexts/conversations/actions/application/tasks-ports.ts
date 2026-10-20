export interface TaskRow {
  id: string;
  recordId: string | null;
  personId: string;
  personName: string | null;
  /** `lead` or `contact`: where the Actions queue links the task. */
  personLifecycle: string;
  /** The person's public conversation on the active channel, or null. */
  conversationId: string | null;
  name: string;
  description: string | null;
  isCompleted: boolean;
  dueAt: Date | null;
  createdBy: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  completedAt: Date | null;
  createdAt: Date;
}

/**
 * What a note or task hangs on. A record scope writes `record_id` and finds only that record's rows. A person scope works
 * without a reply record: it writes `record_id` null and finds every row of the person, record-bound ones included.
 */
export type NoteScope = { recordId: string; personId?: never } | { personId: string; recordId?: never };

export interface TaskListFilter {
  /** `open` hides completed tasks. */
  state: "open" | "completed" | "all";
  /** Only tasks held by this user. */
  assigneeId?: string;
  recordId?: string;
  /** Every task of the person, with or without a record. */
  personId?: string;
  limit: number;
}

export interface MemberOption {
  userId: string;
  name: string;
}

export interface NoteRow {
  id: string;
  createdBy: string | null;
}

export interface PersonNote {
  id: string;
  recordId: string | null;
  title: string | null;
  body: string;
  createdAt: Date;
  authorName: string | null;
  createdBy: string | null;
}

export interface TaskStore {
  /** Open tasks sort overdue first, then by due date, then undated; completed tasks sort last. */
  list(organizationId: string, filter: TaskListFilter): Promise<TaskRow[]>;
  recordExists(organizationId: string, recordId: string): Promise<boolean>;
  personExists(organizationId: string, personId: string): Promise<boolean>;
  get(organizationId: string, taskId: string): Promise<TaskRow | null>;
  /** Null when the record or person is not in the organization. */
  create(input: {
    organizationId: string;
    actorUserId: string;
    scope: NoteScope;
    name: string;
    description: string | null;
    dueAt: Date | null;
    assigneeId: string | null;
  }): Promise<{ id: string } | null>;
  update(input: {
    organizationId: string;
    taskId: string;
    patch: { name?: string; description?: string | null; dueAt?: Date | null; assigneeId?: string | null };
  }): Promise<boolean>;
  setCompleted(input: { organizationId: string; taskId: string; actorUserId: string; completed: boolean; now: Date }): Promise<boolean>;
  delete(organizationId: string, taskId: string): Promise<boolean>;
  /** True when the user belongs to the organization. */
  isMember(organizationId: string, userId: string): Promise<boolean>;
  members(organizationId: string): Promise<Array<{ userId: string; name: string }>>;

  getNote(organizationId: string, scope: NoteScope, noteId: string): Promise<NoteRow | null>;
  updateNote(input: { organizationId: string; scope: NoteScope; noteId: string; title: string | null; body: string }): Promise<boolean>;
  /** Every note of the person, record-bound ones included, newest first. */
  personNotes(organizationId: string, personId: string): Promise<PersonNote[]>;

  /** Sets the flag on a message in the organization. Null when the message is not found. */
  setMessageImportant(organizationId: string, messageId: string, important: boolean): Promise<boolean>;
}
