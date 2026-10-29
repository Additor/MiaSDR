import { CircleHelpIcon, CircleXIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { getReplyTypeCatalog } from "@/contexts/conversations/application/reply-handling";
import { getWorkQueue, getWorkQueueCounts, getWorkQueueExtras } from "@/contexts/conversations/actions/application/work-queue";
import { listTasks } from "@/contexts/conversations/actions/application/tasks";
import type { QueueItem } from "@/contexts/conversations/actions/application/work-queue-ports";
import type { TaskRow } from "@/contexts/conversations/actions/application/tasks-ports";
import { taskDeps } from "@/contexts/conversations/actions/infrastructure/task-composition";
import { QUEUE_GROUPS, QUEUE_GROUP_LABELS, isQueueScope, isWorkClear, scopeOf, type QueueScope } from "@/contexts/conversations/actions/domain/action-queue";
import { replyHandlingDeps } from "@/contexts/conversations/infrastructure/reply-handling-composition";
import { workQueueDeps } from "@/contexts/conversations/actions/infrastructure/work-queue-composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { listInboundEvents } from "@/contexts/outreach/application/inbound-review";
import { inboundReviewDeps } from "@/contexts/outreach/infrastructure/inbound-review-composition";
import { listCampaigns } from "@/contexts/outreach/application/campaign-management";
import { channelLabel } from "@/contexts/outreach/domain/campaign-view";
import { listLinkedInCampaigns } from "@/contexts/outreach/linkedin/application/linkedin-campaigns";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { linkedinCampaignDeps } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import { cn } from "@/components/ui/utils";
import { toActor } from "@/app/_lib/api";
import { ForbiddenError, ValidationError } from "@/shared/errors";
import { elapsed } from "@/shared/format-time";
import { countOf, formatCount } from "@/shared/format-number";
import { EmptyState } from "@/components/shell/empty-state";
import { LIST_ROW_FRAME } from "@/components/shell/list-row";
import { ListKeys } from "@/components/shell/list-keys";
import { ListSkeleton } from "@/components/shell/list-skeleton";
import { FilterChips } from "@/components/shell/filter-chips";
import { AppliedFilters } from "@/components/shell/filter-chip";
import { ListToolbar } from "@/components/shell/list-toolbar";
import { InfoTip, KeyboardHint } from "@/components/shell/info-tip";
import { PageHeader } from "@/components/shell/page-header";
import { Count, Section } from "@/components/shell/section";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { Time } from "@/components/shell/time";
import { personHref } from "@/app/(app)/_components/person/person-href";
import { ACTIONS_FILTER_KEYS, actionsViewFrom, threadQueryFromActions } from "./actions-query";
import { hasAnyFilter } from "./more-filters";
import { queueFilterChips, QueueFilters } from "./queue-filters";
import { QueueGroup, QueueNotice, type QueueItemView } from "./queue-group";
import { ambiguousTypeNames } from "./type-label";

export const metadata: Metadata = { title: "Actions" };

export default function ActionsPage({ searchParams }: PageProps<"/actions">) {
  return (
    <>
      <PageHeader title="Actions" />
      <div className="page stack-group">
        <Suspense fallback={<ListSkeleton bordered label="Loading the queue" />}>
          <Queue searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

/**
 * A list of work below the queue, in the shell's plain section frame like the queue groups above. A source with nothing in it
 * has no section; the jump strip names it on its "Nothing in" line instead.
 */
function ListSection({ id, title, description, count, icon, error = false, children }: { id: string; title: string; description?: string; count: number; icon?: ReactNode; error?: boolean; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <Section
      frame="plain"
      sectionId={id}
      label={title}
      title={title}
      icon={icon}
      // Lavender marks work that waits for a person. A dead letter is an error no retry fixes, so its count is red like its icon.
      count={formatCount(count)}
      countTone={error ? "error" : "waiting"}
      help={description ? <InfoTip label={`About ${title}`}>{description}</InfoTip> : undefined}
    >
      <ul className="divide-y rounded-lg border text-sm">{children}</ul>
    </Section>
  );
}

/** The keyboard row: j and k move through every row on the page, Enter opens it (components/shell/list-keys.tsx). */
const ROW_FRAME = LIST_ROW_FRAME;

/** One row of work below the queue: the title is the link and stretches over the row, the verb says what opening it does. */
function Row({ id, title, detail, href, action, icon }: { id: string; title: ReactNode; detail?: ReactNode; href: string; action: string; icon?: ReactNode }) {
  return (
    <li data-list-row={id} data-href={href} className={cn(rowLinkClasses, ROW_FRAME)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-1.5">
          {icon}
          <RowLink href={href} className="truncate">
            {title}
            <span className="sr-only">, {action}</span>
          </RowLink>
        </div>
        <span className="shrink-0 text-xs font-medium text-foreground">{action}</span>
      </div>
      {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
    </li>
  );
}

/** A contact's task opens the contact page; a lead's opens the conversation, or the lead page when there is none. */
function taskTarget(t: TaskRow): { href: string; action: string } {
  if (t.personLifecycle === "contact") return { href: personHref(t.personId, t.personLifecycle), action: "Open contact" };
  if (t.conversationId) return { href: `/inbox/${t.conversationId}`, action: "Open conversation" };
  return { href: personHref(t.personId, t.personLifecycle), action: "Open lead" };
}

const TASK_SECTIONS: Record<QueueScope, string> = { mine: "Your tasks", unassigned: "Unassigned tasks", others: "Tasks held by teammates" };

const toView = (item: QueueItem): QueueItemView => JSON.parse(JSON.stringify(item));

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

async function Queue({ searchParams }: { searchParams: PageProps<"/actions">["searchParams"] }) {
  await connection();
  const actor = toActor(await requireOrgContext());
  const params = await searchParams;
  // The page opens on the viewer's own work. An unknown scope in the URL reads the same way.
  const scopeParam = first(params.scope);
  const scope: QueueScope = isQueueScope(scopeParam) ? scopeParam : "mine";
  const raw: Record<string, string> = { ...Object.fromEntries(ACTIONS_FILTER_KEYS.map((k) => [k, first(params[k])])), scope };
  const query = new URLSearchParams(Object.entries(raw).filter(([, v]) => v !== "")).toString();
  const result = await getWorkQueue(workQueueDeps(), actor, { filter: raw }).then(
    (queue) => ({ queue, filterError: null as string | null }),
    (error) => {
      if (error instanceof ValidationError) return { queue: null, filterError: error.message };
      throw error;
    },
  );
  const { queue, filterError } = result;
  const [taxonomy, emailCampaigns, linkedinCampaigns, extras, counts] = await Promise.all([
    getReplyTypeCatalog(replyHandlingDeps(), actor),
    listCampaigns(campaignDeps(), actor),
    listLinkedInCampaigns(linkedinCampaignDeps(), actor),
    getWorkQueueExtras(workQueueDeps(), actor),
    getWorkQueueCounts(workQueueDeps(), actor),
  ]);
  // Archived campaigns are hidden by default. The list holds both channels, because the queue does too.
  const campaigns = [...emailCampaigns, ...linkedinCampaigns].map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
  const openTasks = await listTasks(taskDeps(), actor, { state: "open" });
  const now = taskDeps().now().getTime();
  // The tasks of the scope in view. A task has an assignee or none, like a record.
  const scopedTasks = openTasks.filter((t) => scopeOf(t.assigneeId, actor.userId) === scope);
  // Dead letters are for owners and admins, like /settings/inbound-events.
  const dead = await listInboundEvents(inboundReviewDeps(), actor, { state: "dead", limit: 10 }).catch((error) => {
    if (error instanceof ForbiddenError) return null;
    throw error;
  });

  const taskRow = (t: TaskRow) => {
    const overdue = t.dueAt !== null && t.dueAt.getTime() < now;
    const target = taskTarget(t);
    return (
      <Row
        key={t.id}
        id={`task-${t.id}`}
        href={target.href}
        action={target.action}
        title={t.name}
        detail={
          <>
            {t.personName ?? "Unknown person"},{" "}
            {t.dueAt ? (
              overdue ? (
                <span className="font-medium text-foreground">
                  overdue, <Time value={t.dueAt} dateOnly />
                </span>
              ) : (
                <>
                  due <Time value={t.dueAt} dateOnly />
                </>
              )
            ) : (
              "no due date"
            )}
            , {t.assigneeName ?? "unassigned"}
          </>
        }
      />
    );
  };

  // Groups with work show in their usual order. The empty ones collapse into one line below them.
  const visibleGroups = QUEUE_GROUPS.filter((g) => (raw.errorsOnly !== "" ? g === "problem" : !raw.group || raw.group === g));
  const groups = queue ? visibleGroups.filter((g) => queue.groups[g].total > 0) : [];
  const queueEmpty = queue !== null && groups.length === 0;
  const nowIso = new Date(now).toISOString();
  const oldestWaiting = counts.oldestWaiting[scope];
  const filterValues = { category: raw.category, channel: raw.channel, group: raw.group, replyTypeId: raw.replyTypeId, campaignId: raw.campaignId, dueAfter: raw.dueAfter, dueBefore: raw.dueBefore, errorsOnly: raw.errorsOnly !== "" };
  const filtered = hasAnyFilter(filterValues);
  // "Nothing waits" holds only when tasks, unconfirmed sends, unmatched senders and dead letters are empty too.
  const clear = isWorkClear({
    queue: queue?.total ?? 0,
    tasks: scopedTasks.length,
    uncertainCampaignSends: extras.uncertainCampaignSends.length,
    unmatchedSenders: extras.openIdentityExceptions,
    deadLetters: dead?.total ?? 0,
  });

  // The oldest wait has a name when it is the first item of one of the lists in view, which it is unless a filter hides it.
  const view = actionsViewFrom(params);
  const oldestCandidate = queue
    ? QUEUE_GROUPS.flatMap((g) => queue.groups[g].items.slice(0, 1))
        .filter((i) => i.waitingSince.basis !== "due")
        .sort((a, b) => a.waitingSince.at.getTime() - b.waitingSince.at.getTime())[0]
    : undefined;
  const oldestItem =
    oldestCandidate && oldestWaiting && oldestCandidate.waitingSince.at.getTime() === oldestWaiting.getTime()
      ? {
          name: oldestCandidate.personName ?? "an unknown sender",
          href: oldestCandidate.conversationId ? `/inbox/${oldestCandidate.conversationId}?${threadQueryFromActions(view)}` : personHref(oldestCandidate.personId, oldestCandidate.personLifecycle),
        }
      : null;
  const SHORT: Record<(typeof QUEUE_GROUPS)[number], string> = { problem: "Problems", reply: "Replies", follow_up: "Follow-ups", classification: "AI picks", next_step: "Next steps" };
  // Every group in view with its count. A list with work is a jump link; the empty ones fold into one muted line, so the
  // strip says what waits without a row of zeros.
  const lists = [
    ...visibleGroups.map((g) => ({ href: `#group-${g}`, label: SHORT[g], count: queue?.groups[g].total ?? 0, error: false })),
    { href: "#section-tasks", label: "Tasks", count: scopedTasks.length, error: false },
    ...(extras.uncertainCampaignSends.length > 0 ? [{ href: "#section-sends", label: "Unconfirmed sends", count: extras.uncertainCampaignSends.length, error: false }] : []),
    ...(dead && dead.total > 0 ? [{ href: "#section-dead", label: "Dead letters", count: dead.total, error: true }] : []),
    ...(extras.openIdentityExceptions > 0 ? [{ href: "#section-unmatched", label: "Unmatched senders", count: extras.openIdentityExceptions, error: false }] : []),
  ];
  const jumps = lists.filter((l) => l.count > 0);
  const emptyLists = lists.filter((l) => l.count === 0).map((l) => l.label);

  const scopeHref = (target: QueueScope) => {
    const rest = new URLSearchParams(Object.entries(raw).filter(([key, value]) => key !== "scope" && value !== ""));
    rest.set("scope", target);
    return `/actions?${rest.toString()}`;
  };
  const scopeChips = [
    { scope: "mine", label: "Mine" },
    { scope: "unassigned", label: "Unassigned" },
    { scope: "others", label: "Others" },
  ] as const;
  const unassignedCount = counts.work.unassigned;
  const replyTypes = taxonomy.replyTypes.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name, groupKey: t.groupKey }));
  const ambiguousTypes = [...ambiguousTypeNames(replyTypes)];
  const queueChips = queueFilterChips(filterValues, scope, { replyTypes, campaigns });

  return (
    <>
      <ListKeys />
      <QueueNotice />
      <ListToolbar
        end={groups.length > 0 || scopedTasks.length > 0 ? <KeyboardHint noun="rows" /> : undefined}
        filters={<QueueFilters values={filterValues} scope={scope} count={queueChips.length} replyTypes={replyTypes} campaigns={campaigns} />}
      >
        <FilterChips label="Whose work" items={scopeChips.map((c) => ({ href: scopeHref(c.scope), active: scope === c.scope, testId: `scope-${c.scope}`, label: c.label, count: counts.work[c.scope] }))} />
      </ListToolbar>
      <AppliedFilters chips={queueChips} clear={{ href: `/actions?scope=${scope}` }} />
      {!clear && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
          <nav aria-label="Jump to a list" className="flex flex-wrap gap-x-4 text-muted-foreground" data-testid="queue-jumps">
            {jumps.map((jump) => (
              <a key={jump.href} href={jump.href} className="inline-flex min-h-8 items-center gap-1 rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-ring max-sm:min-h-11">
                {jump.label} <Count value={formatCount(jump.count)} tone={jump.error ? "error" : "waiting"} />
              </a>
            ))}
            {emptyLists.length > 0 && (
              <span className="inline-flex min-h-8 items-center max-sm:min-h-11" data-testid="queue-jumps-empty">
                Nothing in {emptyLists.join(", ")}.
              </span>
            )}
          </nav>
          {oldestWaiting && (
            <p className="text-muted-foreground" data-testid="queue-oldest">
              Oldest wait {elapsed(oldestWaiting, nowIso, true)}
              {oldestItem && (
                <>
                  {", "}
                  <Link href={oldestItem.href} className="rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-ring" data-testid="queue-oldest-link">
                    {oldestItem.name}
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
      )}
      {filterError && (
        <p role="alert" className="text-sm text-destructive">
          {filterError}
        </p>
      )}
      {queue && queueEmpty && (filtered || clear) && (
        <EmptyState
          title={hasAnyFilter(filterValues) ? "No actions match these filters" : scope === "others" ? "Teammates have nothing waiting" : scope === "unassigned" ? "Nothing is waiting for someone to take it" : "Nothing waits on you"}
          description={
            hasAnyFilter(filterValues)
              ? "Clear a filter to see the whole queue."
              : scope === "mine" && unassignedCount > 0
                ? `${formatCount(unassignedCount)} ${unassignedCount === 1 ? "item has" : "items have"} no one assigned yet.`
                : scope !== "mine"
                  ? "Work that someone handles shows here. Yours is under Mine."
                  : "A conversation lands here when a reply needs approval, an AI pick waits for you or a follow-up comes due."
          }
          action={
            hasAnyFilter(filterValues)
              ? { label: "Clear filters", href: `/actions?scope=${scope}` }
              : scope === "mine" && unassignedCount > 0
                ? { label: "Show unassigned", href: "/actions?scope=unassigned" }
                : { label: "Open the Inbox", href: "/inbox" }
          }
        />
      )}
      {queue &&
        !queueEmpty &&
        groups.map((g) => {
          const page = queue.groups[g];
          return (
            <QueueGroup
              // Filters mount a fresh group; a refresh keeps it mounted, so focus stays on the row after a settled one.
              key={`${g}:${query}`}
              group={g}
              title={QUEUE_GROUP_LABELS[g].title}
              description={g === "classification" || g === "problem" ? QUEUE_GROUP_LABELS[g].description : undefined}
              total={page.total}
              initialItems={page.items.map(toView)}
              initialCursor={page.nextCursor}
              query={query}
              showAssignee={scope === "others"}
              now={nowIso}
              ambiguousTypes={ambiguousTypes}
            />
          );
        })}

      <ListSection id="section-tasks" title={TASK_SECTIONS[scope]} count={scopedTasks.length}>
        {scopedTasks.map(taskRow)}
      </ListSection>

      <ListSection
        id="section-sends"
        icon={<CircleHelpIcon aria-hidden className="size-4 shrink-0 text-warning" />}
        title="Unconfirmed sends"
        description="The provider never confirmed delivery. Check the mailbox's Sent folder and mark what you found. Nothing is sent again."
        count={extras.uncertainCampaignSends.length}
      >
        {extras.uncertainCampaignSends.map((s) => (
          <Row
            key={s.sendId}
            id={`send-${s.sendId}`}
            icon={<CircleHelpIcon aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-warning" />}
            href={`/campaigns/${s.campaignId}`}
            action="Open campaign"
            title={`${s.campaignName}: ${s.personName ?? "an unknown person"}`}
            detail={
              <>
                {channelLabel(s.channel)} step claimed <Time value={s.claimedAt} />
              </>
            }
          />
        ))}
      </ListSection>

      {/* Dead letters are for owners and admins, so a member sees no section for them. */}
      {dead && (
        <ListSection
          id="section-dead"
          icon={<CircleXIcon aria-hidden className="size-4 shrink-0 text-destructive" />}
          title="Dead letters"
          description="Messages we could not file after every retry. Retry or dismiss them in Settings, under Inbound events."
          count={dead.total}
          error
        >
          {dead.rows.map((e) => (
            <Row
              key={e.id}
              id={`dead-${e.id}`}
              icon={<CircleXIcon aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-destructive" />}
              href="/settings/inbound-events"
              action="Open"
              title={`${e.source === "gmail" ? (e.from ?? "Unknown sender") : "LinkedIn delivery"}${e.subject ? `: ${e.subject}` : ""}`}
              detail={`${countOf(e.attempts, "attempt")}${e.error ? `, ${e.error}` : ""}`}
            />
          ))}
        </ListSection>
      )}

      <ListSection id="section-unmatched" title="Unmatched senders" description="Messages from senders we could not match to a person. File each one under a person." count={extras.openIdentityExceptions}>
        <Row
          id="unmatched"
          href="/inbox/unmatched"
          action="Review senders"
          title={`${countOf(extras.openIdentityExceptions, "message")} ${extras.openIdentityExceptions === 1 ? "waits for you to file it" : "wait for you to file them"} under a person.`}
        />
      </ListSection>

    </>
  );
}
