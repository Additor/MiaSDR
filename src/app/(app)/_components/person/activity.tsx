import { connection } from "next/server";
import { Tabs } from "@/components/shell/tabs";
import { Time } from "@/components/shell/time";
import type { PersonEventView } from "@/contexts/conversations/application/person-ports";
import { listPersonNotes, listTasks } from "@/contexts/conversations/actions/application/tasks";
import { canChangeTask } from "@/contexts/conversations/actions/domain/tasks";
import { personReplyHandling } from "@/contexts/conversations/infrastructure/composition";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import type { Actor } from "@/shared/errors";
import { eventLabel } from "../event-labels";
import { RecordSection } from "../record/record-header";
import { toJson } from "../serialize";
import { NotesPanel } from "./notes-panel";
import { TasksPanel } from "./tasks-panel";

const HISTORY_LIMIT = 50;

/** The typed part of an event worth a second look: a lost reason, a deal title, a note, a do-not-contact reason. */
export function eventDetail(event: PersonEventView): string | null {
  const to = event.toData as { lostReason?: unknown } | null;
  const meta = event.meta as { title?: unknown; note?: unknown; reason?: unknown } | null;
  // `reason` is a code token on most events; only the do-not-contact events carry a reason a person typed.
  const reason = event.eventType.startsWith("contact_policy.") ? meta?.reason : null;
  for (const value of [to?.lostReason, event.eventType === "deal.created" || event.eventType === "deal.deleted" ? meta?.title : null, meta?.note, reason]) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/** Events newest first, each with its time. `who` prefixes a line with the person's name on a company page. */
export function EventList({ events, who, limit }: { events: Array<PersonEventView & { who?: string }>; who?: boolean; limit: number }) {
  return (
    <div className="grid gap-2" data-testid="activity-history">
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>
      ) : (
        <ol className="divide-y text-sm" aria-label="History">
          {events.map((event) => {
            const detail = eventDetail(event);
            return (
              <li key={event.id} className="grid gap-0.5 py-2 sm:grid-cols-[1fr_auto] sm:gap-3">
                <span className="min-w-0 break-words">
                  {who && event.who && <span className="font-medium">{`${event.who}: `}</span>}
                  {eventLabel(event)}
                  {detail && <span className="text-muted-foreground">{`: ${detail}`}</span>}
                </span>
                <Time value={event.createdAt} className="text-xs text-muted-foreground tabular-nums" />
              </li>
            );
          })}
        </ol>
      )}
      {events.length === limit && <p className="text-xs text-muted-foreground">{`The latest ${limit} events.`}</p>}
    </div>
  );
}

/**
 * A person's activity: what happened (deal events, the conversion, reply handling; personal-campaign threads left out),
 * their notes and their tasks, as tabs under one heading. Lead, contact and deal pages share it. Wrap it in Suspense.
 */
export async function PersonActivity({ actor, personId, first = "history" }: { actor: Actor; personId: string; first?: "history" | "tasks" }) {
  await connection();
  const deps = taskDeps();
  const [events, notes, tasks, members] = await Promise.all([
    personReplyHandling.listPersonEvents(actor.organizationId, personId, HISTORY_LIMIT),
    listPersonNotes(deps, actor, personId),
    listTasks(deps, actor, { state: "all", personId }),
    deps.store.members(actor.organizationId),
  ]);
  const admin = isOwnerOrAdmin(actor.role);
  const openTasks = tasks.filter((t) => !t.isCompleted).length;
  const history = { id: "history", label: "History", content: <EventList events={events} limit={HISTORY_LIMIT} /> };
  const taskTab = {
    id: "tasks",
    label: "Tasks",
    count: openTasks,
    content: (
      <TasksPanel
        personId={personId}
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
    ),
  };
  const noteTab = {
    id: "notes",
    label: "Notes",
    count: notes.length,
    content: <NotesPanel personId={personId} notes={toJson(notes)} currentUserId={actor.userId} isAdmin={admin} />,
  };

  return (
    <RecordSection title="Activity" testId="person-activity">
      <Tabs label="Activity" countTone="neutral" tabs={first === "tasks" ? [taskTab, noteTab, history] : [history, noteTab, taskTab]} />
    </RecordSection>
  );
}
