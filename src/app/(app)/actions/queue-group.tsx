"use client";

import { CircleHelpIcon, CircleXIcon, MailIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { LIST_ROW_FRAME } from "@/components/shell/list-row";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { InfoTip } from "@/components/shell/info-tip";
import { Time } from "@/components/shell/time";
import { callApi } from "@/app/_lib/api-client";
import { cn } from "@/components/ui/utils";
import { channelLabel } from "@/contexts/outreach/domain/campaign-view";
import type { PickReviewKind } from "@/contexts/conversations/actions/domain/action-queue";
import { personHref } from "@/app/(app)/_components/person/person-href";
import { LinkedInMark } from "@/app/(app)/_components/person/reach-icons";
import { confidenceText, LOOKS_RIGHT_DONE } from "@/app/(app)/inbox/[id]/_lib/type-line";
import { threadQueryFromActions } from "./actions-query";
import { typeLabel } from "./type-label";
import { waitingLabel } from "./waiting-label";

/** A queue item as it crosses the network: dates are ISO strings. */
export interface QueueItemView {
  recordId: string;
  personId: string;
  group: string;
  personName: string | null;
  personLifecycle: "lead" | "contact";
  conversationId: string | null;
  groupKey: string | null;
  replyTypeName: string | null;
  channel: string | null;
  workflowState: string;
  assignee: { id: string; name: string | null } | null;
  nextActionAt: string | null;
  snippet: string | null;
  waitingSince: { at: string; basis: "inbound" | "failure" | "due" };
  draft: { draftId: string; status: string; subject: string | null; updatedAt: string; preview: string | null } | null;
  classification: { replyTypePickId: string; kind: PickReviewKind; groupKey: string | null; name: string | null; confidence: number | null; contextVersion: number } | null;
  problem: { kind: "record_error" | "draft_failed" | "delivery_uncertain" | "job_failed"; message: string } | null;
}

interface GroupResponse {
  groups: Record<string, { total: number; items: QueueItemView[]; nextCursor: string | null }>;
}

/**
 * Where a row opens. Reply handling lives on the thread, and the link names the queue it came from (`from=actions` and the
 * page's filters), so the thread can go back to the same view and offer the next item. Without a public thread the person's
 * own page is the place left.
 */
function rowHref(item: QueueItemView, query: string): string {
  if (!item.conversationId) return personHref(item.personId, item.personLifecycle);
  return `/inbox/${item.conversationId}?${threadQueryFromActions(Object.fromEntries(new URLSearchParams(query)))}`;
}

/** Review stop request opens the thread with Stop contacting open (`stop=1`). Null without a public thread. */
function stopHref(item: QueueItemView, query: string): string | null {
  return item.conversationId ? `${rowHref(item, query)}&stop=1` : null;
}

/** The channel as a mark after the name, with its name for screen readers. */
function ChannelMark({ channel }: { channel: string }) {
  return (
    <span role="img" aria-label={channelLabel(channel)} className="inline-flex shrink-0 translate-y-0.5 text-muted-foreground [&_svg]:size-3.5" data-testid="queue-channel">
      {channel === "linkedin" ? <LinkedInMark /> : <MailIcon aria-hidden />}
    </span>
  );
}

/** A done notice for one row of many, so a screen reader hears whose row left: "Marked as looked at: Eli Moss." */
const doneFor = (done: string, name: string | null) => `${done.replace(/\.$/, "")}: ${name ?? "the sender"}.`;

const ACCEPTED = "AI pick accepted.";

/**
 * The mark of a problem row. A send that may or may not have gone out is uncertain, so it takes the amber icon and nothing else
 * (DESIGN.md: never a fill, never red). A draft, a job or a record that failed is an error a person has to fix, so its icon is red.
 */
function ProblemMark({ kind }: { kind: NonNullable<QueueItemView["problem"]>["kind"] }) {
  if (kind === "delivery_uncertain") return <CircleHelpIcon aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-warning" />;
  return <CircleXIcon aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-destructive" />;
}

/** The line under the snippet and the verb at its end: what waits on the person in this row. */
function describe(item: QueueItemView, ambiguous: ReadonlySet<string>): { detail: ReactNode; action: string } {
  const contact = item.personLifecycle === "contact";
  const open = item.conversationId ? "Open conversation" : contact ? "Open contact" : "Open lead";
  switch (item.group) {
    case "reply":
      // What the person has to judge is the draft, not the subject, which only repeats the thread's.
      return {
        detail: item.draft?.preview ? `Draft: ${item.draft.preview}` : (item.draft?.subject ?? "(no subject)"),
        action: "Review and send",
      };
    case "classification": {
      const c = item.classification;
      if (c?.kind === "stop_review") {
        // The AI's uncertain reading, worded as on the thread: the amber icon and lead words, the sentence in the foreground.
        return {
          detail: (
            <>
              <CircleHelpIcon aria-hidden className="mr-1 inline size-3.5 -translate-y-px text-warning" />
              <span className="font-medium text-warning">Possible stop request.</span> Nothing stops until you choose.
            </>
          ),
          action: "Review stop request",
        };
      }
      const label = typeLabel(c?.name ?? null, c?.groupKey ?? null, ambiguous) ?? "a type";
      const confidence = c?.confidence != null ? `, ${confidenceText(c.confidence)}` : "";
      return c?.kind === "held" ? { detail: `AI picked ${label}${confidence}`, action: "Accept" } : { detail: `AI applied ${label}${confidence}`, action: "Looks right" };
    }
    case "follow_up":
      return {
        detail: item.nextActionAt ? (
          <>
            Follow-up due <Time value={item.nextActionAt} />
          </>
        ) : (
          "Follow-up due"
        ),
        action: open,
      };
    case "problem":
      if (item.problem?.kind === "draft_failed") return { detail: item.problem.message, action: "Fix draft" };
      if (item.problem?.kind === "delivery_uncertain") return { detail: item.problem.message, action: "Resolve" };
      return { detail: item.problem?.message ?? "Something failed.", action: open };
    default:
      return { detail: "No draft or AI pick waits on this reply.", action: open };
  }
}

export function QueueGroup({
  group,
  title,
  description,
  total,
  initialItems,
  initialCursor,
  query,
  showAssignee,
  now,
  ambiguousTypes,
}: {
  group: string;
  title: string;
  /** Help for a group whose name needs it, on an info mark beside the heading. */
  description?: string;
  total: number;
  initialItems: QueueItemView[];
  initialCursor: string | null;
  /** The page's filters as a query string without group and cursor. */
  query: string;
  /** Name who handles each item. The Mine view leaves it out, because every item is the viewer's. */
  showAssignee: boolean;
  /** The server's clock as an ISO string, so the waiting times print the same on the server and in the browser. */
  now: string;
  /** Lowercased type names more than one group uses (`ambiguousTypeNames`): rows name their group too. */
  ambiguousTypes: string[];
}) {
  const ambiguous = new Set(ambiguousTypes);
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const list = useRef<HTMLUListElement>(null);
  // After Load more the button can vanish with the last page, so focus moves to the first new row instead of the body.
  const focusAfterLoad = useRef<string | null>(null);

  useEffect(() => {
    const id = focusAfterLoad.current;
    if (!id) return;
    focusAfterLoad.current = null;
    list.current?.querySelector<HTMLElement>(`[data-list-row="${id}"] a`)?.focus();
  }, [items]);

  /** Takes rows out of the list and puts focus on the row that moved up into their place. */
  function removeRows(ids: string[]) {
    const at = items.findIndex((i) => ids.includes(i.recordId));
    const rest = items.filter((i) => !ids.includes(i.recordId));
    focusAfterLoad.current = rest[Math.min(at, rest.length - 1)]?.recordId ?? null;
    setItems(rest);
  }

  /**
   * Answers an AI pick row where it stands. A held pick is accepted as it is (a person who disagrees opens the thread and
   * changes the type); an applied pick is marked as looked at (Looks right). Both go through the endpoints the thread uses, so
   * a stale pick answers 409 here as it does there. A stop request is never accepted here: if a held pick turns out to be one,
   * the server answers `stop_review` and the thread opens with Stop contacting.
   */
  async function settle(item: QueueItemView): Promise<boolean> {
    const c = item.classification;
    if (!c || c.kind === "stop_review") return false;
    const result =
      c.kind === "held"
        ? item.conversationId
          ? await callApi(`/api/inbox/${item.conversationId}/reply-type`, "POST", { replyTypeKey: null, expectedContextVersion: c.contextVersion })
          : { ok: false, error: "Open the person to decide.", details: null }
        : await callApi(`/api/reply-type-picks/${c.replyTypePickId}/acknowledge`, "POST");
    if (!result.ok) {
      const stop = result.details?.code === "stop_review" ? stopHref(item, query) : null;
      if (stop) router.push(stop);
      else setRowErrors((current) => ({ ...current, [item.recordId]: result.error ?? "Could not save. Try again." }));
      return false;
    }
    return true;
  }

  async function decide(item: QueueItemView) {
    if (rowBusy) return;
    setRowBusy(item.recordId);
    setRowErrors((errors) => Object.fromEntries(Object.entries(errors).filter(([id]) => id !== item.recordId)));
    const ok = await settle(item);
    setRowBusy(null);
    if (ok) {
      removeRows([item.recordId]);
      setNotice(doneFor(item.classification?.kind === "held" ? ACCEPTED : LOOKS_RIGHT_DONE, item.personName));
    }
    // Totals and the group the record moves to are the server's to say.
    router.refresh();
  }

  /** Applied picks the AI was at least 90 percent sure of. A held pick or a stop request needs a person's eyes, so it is never in here. */
  const confident = group === "classification" ? items.filter((i) => i.classification?.kind === "looks_right" && (i.classification.confidence ?? 0) >= 0.9) : [];

  async function markConfident() {
    if (rowBusy) return;
    setRowBusy("bulk");
    const done: string[] = [];
    for (const item of confident) {
      if (!(await settle(item))) break;
      done.push(item.recordId);
    }
    setRowBusy(null);
    if (done.length > 0) {
      removeRows(done);
      setNotice(`Marked ${done.length} ${done.length === 1 ? "AI pick" : "AI picks"} as looked at.`);
    }
    router.refresh();
  }

  async function loadMore() {
    if (!cursor || busy) return;
    setBusy(true);
    setError(null);
    const params = new URLSearchParams(query);
    params.set("group", group);
    params.set("cursor", cursor);
    const result = await callApi<GroupResponse>(`/api/actions?${params.toString()}`, "GET");
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? "Could not load more.");
      return;
    }
    const page = result.data.groups[group];
    const seen = new Set(items.map((i) => i.recordId));
    const added = page.items.filter((i) => !seen.has(i.recordId));
    focusAfterLoad.current = added[0]?.recordId ?? null;
    setItems((current) => {
      const have = new Set(current.map((i) => i.recordId));
      return [...current, ...added.filter((i) => !have.has(i.recordId))];
    });
    setCursor(page.nextCursor);
  }

  // The same frame as the lists below the queue (actions/page.tsx Section): heading and count, help on an info mark where
  // the name needs it, then one bordered list with hairlines between the items. The count stays lavender: it is work that waits for a person.
  return (
    <section id={`group-${group}`} aria-label={title} data-slot="queue-group" data-group={group} className="grid scroll-mt-4 gap-2">
      {/* The row wraps, so a long bulk button drops under the title on a phone instead of widening the page. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs font-semibold text-sidebar-count tabular-nums" data-testid={`queue-total-${group}`}>
          {total}
        </span>
        {description && (
          <span className="self-center">
            <InfoTip label={`About ${title}`}>{description}</InfoTip>
          </span>
        )}
        {confident.length >= 2 && (
          <Button variant="ghost" size="xs" className="ml-auto max-sm:h-11" disabled={rowBusy !== null} onClick={markConfident} data-testid="mark-confident">
            {rowBusy === "bulk" ? "Saving…" : `Looks right: ${confident.length} sure picks`}
          </Button>
        )}
      </div>
      <ul ref={list} className="divide-y rounded-lg border text-sm">
        {items.map((item) => {
          const thread = rowHref(item, query);
          const { detail, action } = describe(item, ambiguous);
          const wait = waitingLabel(item.waitingSince, now);
          const type = typeLabel(item.replyTypeName, item.groupKey, ambiguous);
          const kind = item.classification?.kind;
          const stop = kind === "stop_review" ? stopHref(item, query) : null;
          return (
            <li
              key={item.recordId}
              data-testid="queue-item"
              data-list-row={item.recordId}
              data-href={thread}
              className={cn(rowLinkClasses, LIST_ROW_FRAME)}
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                  {item.problem && <ProblemMark kind={item.problem.kind} />}
                  <RowLink href={thread} className="truncate">
                    {item.personName ?? "Unknown sender"}
                    <span className="sr-only">
                      , {action}, {wait}
                    </span>
                  </RowLink>
                  {item.channel && <ChannelMark channel={item.channel} />}
                  {type && (
                    <span className="hidden truncate text-xs text-muted-foreground sm:inline" data-testid="queue-type">
                      {type}
                    </span>
                  )}
                </div>
                <time dateTime={item.waitingSince.at} className="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="queue-waiting">
                  {wait}
                </time>
              </div>
              {item.snippet && <p className="truncate text-muted-foreground">{item.snippet}</p>}
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">
                  {detail}
                  {showAssignee && <span data-testid="queue-assignee">{` · ${item.assignee ? `Assigned to ${item.assignee.name ?? "a former member"}` : "Unassigned"}`}</span>}
                </span>
                {stop ? (
                  // Above the stretched link. It opens the thread with Stop contacting open; nothing is accepted here.
                  <Link
                    href={stop}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "relative z-10 shrink-0 max-sm:h-11 max-sm:px-4")}
                    aria-label={`${action}: ${item.personName ?? "the sender"}`}
                    data-testid="review-stop"
                  >
                    {action}
                  </Link>
                ) : (kind === "held" && item.conversationId) || kind === "looks_right" ? (
                  // Above the stretched link, so the click settles the row and does not open the thread.
                  <Button
                    variant="outline"
                    size="sm"
                    className="relative z-10 shrink-0 max-sm:h-11 max-sm:px-4"
                    disabled={rowBusy !== null}
                    onClick={() => decide(item)}
                    aria-label={`${action}: ${item.personName ?? "the sender"}`}
                    data-testid="settle"
                  >
                    {rowBusy === item.recordId ? "Saving…" : action}
                  </Button>
                ) : (
                  <span className="shrink-0 font-medium text-foreground">{action}</span>
                )}
              </div>
              {rowErrors[item.recordId] && (
                <p role="alert" className="text-xs text-destructive">
                  {rowErrors[item.recordId]}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {/* The count matters while more can load; with everything shown it stays for screen readers only. */}
      <div className={cn("flex items-center justify-between gap-2 text-xs text-muted-foreground", !cursor && "sr-only")}>
        <span role="status" aria-live="polite">
          Showing {items.length} of {total}
          <span className="sr-only">{notice && ` ${notice}`}</span>
        </span>
        {cursor && (
          <Button variant="outline" size="sm" className="max-sm:h-11 max-sm:px-4" onClick={loadMore} disabled={busy}>
            {busy ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
