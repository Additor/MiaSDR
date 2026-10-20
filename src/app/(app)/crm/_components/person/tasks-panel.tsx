"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { callApi } from "@/lib/api-client";
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
  /** False inside a page section that already names it, such as the Activity tabs. */
  heading?: boolean;
};

export function TasksPanel({ tasks, members, currentUserId, nowMs, heading = true, ...target }: TasksPanelProps) {
  const router = useRouter();
  const createUrl = target.recordId !== undefined ? `/api/crm/records/${target.recordId}/tasks` : `/api/people/${target.personId}/tasks`;
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
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setError(null);
    const result = await callApi(`/api/crm/tasks/${id}`, "PATCH", body);
    if (!result.ok) return setError(result.error);
    router.refresh();
  }

  async function remove(id: string) {
    const result = await callApi(`/api/crm/tasks/${id}`, "DELETE");
    if (!result.ok) throw new Error(result.error ?? "Could not delete the task. Try again.");
    toast.success("Task deleted.");
    router.refresh();
  }

  const content = (
    <div className="stack-group" data-slot="tasks-panel">
      <form onSubmit={add} className="@container grid gap-2" noValidate>
        <div className="grid gap-2 @lg:grid-cols-[minmax(0,1fr)_9.5rem_10rem_auto] @lg:items-end">
          <div className="stack-field">
            <Label htmlFor={`task-name-${fieldKey}`}>New task</Label>
            <Input
              id={`task-name-${fieldKey}`}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              maxLength={200}
              placeholder="Call back on Friday"
              className="max-sm:h-11"
            />
          </div>
          <div className="stack-field">
            <Label htmlFor={`task-due-${fieldKey}`}>Due date</Label>
            <Input id={`task-due-${fieldKey}`} type="date" value={dueDay} onChange={(e) => setDueDay(e.target.value)} className="max-sm:h-11" />
          </div>
          <div className="stack-field">
            <Label id={`task-assignee-${fieldKey}`}>Assign to</Label>
            <MemberSelect labelledBy={`task-assignee-${fieldKey}`} value={assigneeId} members={members} currentUserId={currentUserId} onChange={setAssigneeId} />
          </div>
          <Button type="submit" variant="outline" disabled={pending || zone === null} className="max-sm:h-11">
            Add task
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
      {tasks.length > 0 && (
        <ul className="divide-y border-t" aria-label="Tasks">
          {tasks.map((t) => {
            const overdue = !t.isCompleted && t.dueAt !== null && zone !== null && new Date(t.dueAt).getTime() < nowMs;
            return (
              <li key={t.id} className="grid gap-1 py-2.5 text-sm" data-task-state={t.isCompleted ? "done" : "open"}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <label className="flex min-w-0 items-start gap-2.5">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-foreground max-sm:size-5"
                      checked={t.isCompleted}
                      disabled={!t.canChange}
                      onChange={(e) => patch(t.id, { completed: e.target.checked })}
                      aria-label={t.isCompleted ? `Reopen ${t.name}` : `Complete ${t.name}`}
                    />
                    <span className={t.isCompleted ? "text-muted-foreground line-through" : ""}>{t.name}</span>
                  </label>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {/* A due date is a calendar day in the zone it was set in, which is the browser zone here. */}
                    {t.dueAt && zone && (
                      <span className={overdue ? "font-medium text-destructive" : undefined}>
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
      {heading ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Tasks</CardTitle>
            <CardDescription>Follow-ups for this person. Open tasks also appear in Actions.</CardDescription>
          </CardHeader>
          <CardContent>{content}</CardContent>
        </Card>
      ) : (
        content
      )}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete the task "${deleting?.name ?? ""}"?`}
        description="The task is deleted for everyone in your organization and leaves Actions. This cannot be undone."
        confirmLabel="Delete task"
        pendingLabel="Deleting…"
        destructive
        onConfirm={() => deleting && remove(deleting.id)}
      />
    </>
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
