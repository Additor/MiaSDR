"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { DatePicker, formatDay } from "@/components/shell/date-picker";
import { Time } from "@/components/shell/time";
import { formatDate } from "@/shared/format-time";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { callApi } from "@/app/_lib/api-client";
import { memberItems } from "../member-select";

export interface TaskItem {
  id: string;
  name: string;
  description: string | null;
  isCompleted: boolean;
  dueAt: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  /** The viewer may complete, reassign or delete this task. */
  canChange: boolean;
}

export interface MemberOption {
  userId: string;
  name: string;
}

const noSubscription = () => () => undefined;

/** The viewer's own time zone, known only in the browser so server and client markup agree. */
export function useBrowserZone(): string | null {
  return useSyncExternalStore(
    noSubscription,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    () => null,
  );
}

/** Where the panel writes: a reply record's tasks, or a person's tasks without a record. */
export type TaskTarget = { recordId: string; personId?: never } | { personId: string; recordId?: never };

export type TasksPanelProps = TaskTarget & {
  tasks: TaskItem[];
  members: MemberOption[];
  currentUserId: string;
  nowMs: number;
  /** The form waits behind a New task button, for a side panel where the list matters more than the form. */
  compact?: boolean;
};

export function TasksPanel({ tasks, members, currentUserId, nowMs, compact = false, ...target }: TasksPanelProps) {
  const router = useRouter();
  const createUrl = target.recordId !== undefined ? `/api/records/${target.recordId}/tasks` : `/api/people/${target.personId}/tasks`;
  // Ids of the form fields: unique per panel, so two panels on one page keep their labels apart.
  const fieldKey = target.recordId ?? target.personId;
  const zone = useBrowserZone();
  const [name, setName] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [assigneeId, setAssigneeId] = useState(currentUserId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The target stays set while the dialog closes, so its title does not change mid-animation.
  const [deleting, setDeleting] = useState<TaskItem | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(!compact);
  const nameRef = useRef<HTMLInputElement>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return setError("Name the task first.");
    setPending(true);
    setError(null);
    const result = await callApi(createUrl, "POST", {
      name,
      dueDay: dueDay || null,
      timeZone: zone ?? "UTC",
      assigneeId: assigneeId || null,
    });
    setPending(false);
    if (!result.ok) return setError(result.error);
    setName("");
    setDueDay("");
    toast.success("Task added.");
    router.refresh();
    // The form stays for the next task.
    nameRef.current?.focus();
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setError(null);
    const result = await callApi(`/api/tasks/${id}`, "PATCH", body);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  async function remove(id: string) {
    const result = await callApi(`/api/tasks/${id}`, "DELETE");
    if (!result.ok) throw new Error(result.error ?? "Could not delete the task. Try again.");
    toast.success("Task deleted.");
    router.refresh();
  }

  function closeForm() {
    setFormOpen(false);
    setName("");
    setDueDay("");
    setError(null);
  }

  const openButton = !formOpen && (
    <Button type="button" variant="outline" size="sm" touch onClick={() => setFormOpen(true)}>
      <PlusIcon /> New task
    </Button>
  );

  const content = (
    <div className="stack-group" data-slot="tasks-panel">
      {compact ? (
        // In a side panel the title row carries New task, so an empty list costs one row.
        <div className="flex min-h-7 items-center justify-between gap-3">
          <h2 className="heading-section">Tasks</h2>
          {openButton}
        </div>
      ) : (
        openButton && <div>{openButton}</div>
      )}
      {formOpen && (
        <form onSubmit={add} className="@container grid gap-group" noValidate>
          <FieldGroup className="grid @lg:grid-cols-2">
            <Field className="@lg:col-span-2">
              <FieldLabel htmlFor={`task-name-${fieldKey}`}>Task</FieldLabel>
              <Input
                id={`task-name-${fieldKey}`}
                ref={nameRef}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                maxLength={200}
                placeholder="Call back on Friday"
                autoFocus={compact}
                touch
              />
            </Field>
            <DueField id={`task-due-${fieldKey}`} value={dueDay} onChange={setDueDay} />
            <Field>
              <FieldLabel id={`task-assignee-${fieldKey}`}>Assign to</FieldLabel>
              <MemberSelect labelledBy={`task-assignee-${fieldKey}`} value={assigneeId} members={members} currentUserId={currentUserId} onChange={setAssigneeId} />
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="outline" disabled={pending || zone === null} touch>
              {pending ? "Adding…" : "Add task"}
            </Button>
            {compact && (
              <Button type="button" size="sm" variant="ghost" disabled={pending} touch onClick={closeForm}>
                Cancel
              </Button>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
      )}
      {tasks.length > 0 && (
        <ul className="divide-y border-t" aria-label="Tasks">
          {tasks.map((t) => {
            const overdue = !t.isCompleted && t.dueAt !== null && zone !== null && new Date(t.dueAt).getTime() < nowMs;
            return (
              <li key={t.id} className="grid gap-1 py-2.5 text-sm" data-task-state={t.isCompleted ? "done" : "open"}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <Checkbox
                      id={`task-done-${t.id}`}
                      className="mt-0.5"
                      checked={t.isCompleted}
                      disabled={!t.canChange}
                      onCheckedChange={(checked) => patch(t.id, { completed: checked })}
                      aria-label={t.isCompleted ? `Reopen ${t.name}` : `Complete ${t.name}`}
                    />
                    <label htmlFor={`task-done-${t.id}`} className={t.isCompleted ? "text-muted-foreground line-through" : undefined}>
                      {t.name}
                    </label>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {/* A due date is a calendar day in the zone it was set in, which is the browser zone here. */}
                    {t.dueAt && zone && (
                      <span className={overdue ? "font-medium text-foreground" : undefined}>
                        {overdue ? "Overdue, " : "Due "}
                        <Time value={t.dueAt} zone={zone} dateOnly />
                      </span>
                    )}
                    {t.canChange ? (
                      <MemberSelect
                        label={`Assignee for ${t.name}`}
                        value={t.assigneeId ?? ""}
                        members={members}
                        currentUserId={currentUserId}
                        size="sm"
                        onChange={(value) => patch(t.id, { assigneeId: value || null })}
                      />
                    ) : (
                      <span>{t.assigneeName ?? "Unassigned"}</span>
                    )}
                    {t.canChange && (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setDeleting(t);
                          setDeleteOpen(true);
                        }}
                        aria-label={`Delete ${t.name}`}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
                {t.description && <p className="pl-6.5 whitespace-pre-wrap text-muted-foreground">{t.description}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <>
      {content}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete the task "${deleting?.name ?? ""}"?`}
        description="The task is deleted for everyone in your organization and leaves Actions. This cannot be undone."
        confirmLabel="Delete task"
        cancelLabel="Keep task"
        pendingLabel="Deleting…"
        destructive
        onConfirm={() => deleting && remove(deleting.id)}
      />
    </>
  );
}

/** The browser's calendar day `days` from today, as YYYY-MM-DD. */
export function dayFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return formatDay(d);
}

/** The picked day in the app's date format (yyyy-MM-dd), as `<Time dateOnly>` prints the due date in the list. A day has no zone, so it reads at UTC noon. */
const dayText = (day: string) => formatDate(new Date(`${day}T12:00:00Z`), "UTC");

const QUICK_DAYS: Array<[label: string, days: number]> = [
  ["Today", 0],
  ["Tomorrow", 1],
  ["Next week", 7],
];

/**
 * The due date as three quick choices and Pick a date. Pick a date shows a `DatePicker` with its calendar open; the
 * chosen day reads back under the buttons in the format the task list shows.
 */
export function DueField({ id, value, onChange }: { id: string; value: string; onChange: (day: string) => void }) {
  const [picking, setPicking] = useState(false);
  const quick = QUICK_DAYS.map(([label, days]) => ({ label, day: dayFromToday(days) }));
  return (
    <FieldSet className="min-w-0 gap-field">
      <FieldLegend variant="label" className="leading-none">
        Due
      </FieldLegend>
      <div className="flex flex-wrap gap-1.5">
        {quick.map((q) => (
          <Button key={q.label} type="button" size="sm" variant={value === q.day && !picking ? "secondary" : "outline"} aria-pressed={value === q.day && !picking} touch onClick={() => { setPicking(false); onChange(value === q.day ? "" : q.day); }}>
            {q.label}
          </Button>
        ))}
        <Button type="button" size="sm" variant={picking ? "secondary" : "outline"} aria-pressed={picking} touch onClick={() => setPicking(!picking)}>
          Pick a date
        </Button>
      </div>
      {picking && <DatePicker id={id} aria-label="Due date" value={value} onChange={onChange} defaultOpen className="w-40" />}
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {value ? `Due ${dayText(value)}.` : "No due date."}
      </p>
    </FieldSet>
  );
}

const UNASSIGNED = "unassigned";

/** A member picker in the app's Select. The empty value is "Unassigned". */
function MemberSelect({
  value,
  members,
  currentUserId,
  onChange,
  label,
  labelledBy,
  size = "default",
}: {
  value: string;
  members: MemberOption[];
  currentUserId: string;
  onChange: (value: string) => void;
  label?: string;
  labelledBy?: string;
  size?: "default" | "sm";
}) {
  const items = memberItems(members, currentUserId, value, { value: UNASSIGNED, label: "Unassigned", at: "start" });
  return (
    <Select items={items} value={value || UNASSIGNED} onValueChange={(v) => onChange(v === UNASSIGNED || v === null ? "" : String(v))}>
      <SelectTrigger size={size} aria-label={label} aria-labelledby={labelledBy} className={size === "sm" ? "w-36 max-sm:h-11" : "w-full max-sm:data-[size=default]:h-11"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
