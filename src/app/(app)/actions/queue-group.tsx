"use client";

import { CircleHelpIcon, CircleXIcon, MailIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { LIST_ROW_FRAME } from "@/components/shell/list-row";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { InfoTip } from "@/components/shell/info-tip";
import { SectionHead } from "@/components/shell/section";
import { Time } from "@/components/shell/time";
import { countOf, formatCount } from "@/shared/format-number";
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
  classification: { replyTypePickId: string; kind: PickReviewKind; groupKey: string | null; name: string | null; confidence: number | null; contextVersion: number; unlocksCustomer: boolean } | null;
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

/** How long a settled row stays as a one-line remnant, unless a later refresh replaces the list first. */
const SETTLED_MS = 6_000;

/** A row a person settled in place: one muted line where it stood, so the outcome shows and not only the row leaving. */
interface Settled {
  recordId: string;
  /** Where the row stood, so the remnant stays at that spot while the rows around it change. */
  index: number;
  text: string;
  /** The thread, when the person has a public conversation. */
  href: string | null;
  /** True once a server refresh replaced the list under it; the next one takes it away. */
  survived: boolean;
}

/** What a remnant says: "Accepted Not now for Eli Moss." or "Marked as looked at: Eli Moss." */
function settledText(item: QueueItemView, ambiguous: ReadonlySet<string>): string {
  const c = item.classification;
  const name = item.personName ?? "the sender";
  if (c?.kind !== "held") return doneFor(LOOKS_RIGHT_DONE, item.personName);
  return `Accepted ${typeLabel(c.name, c.groupKey, ambiguous) ?? "the AI pick"} for ${name}.`;
}

const NOTICE_EVENT = "miasdr:actions-notice";

/** Says what a row step did through the page's one live region, `QueueNotice`. */
function announce(text: string) {
  window.dispatchEvent(new CustomEvent(NOTICE_EVENT, { detail: text }));
}

/**
 * The page's live region for row steps (Accept, Looks right). It sits outside the groups: a step can empty a group, the
 * refresh then takes it off the page, and a region inside it would lose the text before a screen reader read it.
 */
export function QueueNotice() {
  const [text, setText] = useState("");
  useEffect(() => {
    const on = (event: Event) => setText((event as CustomEvent<string>).detail);
    window.addEventListener(NOTICE_EVENT, on);
    return () => window.removeEventListener(NOTICE_EVENT, on);
  }, []);
  return (
    <div role="status" className="sr-only" data-testid="queue-notice">
      {text}
    </div>
  );
}

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
      // Accepting this one takes a locked customer out of Existing customer, so the row opens the thread instead of settling.
      if (c?.kind === "held" && c.unlocksCustomer) return { detail: `AI picked ${label}${confidence}. Accepting takes them out of Existing customer.`, action: open };
      // Accept answers on a public thread only; without one the row opens the person.
      if (c?.kind === "held") return { detail: `AI picked ${label}${confidence}`, action: item.conversationId ? "Accept" : open };
      return { detail: `AI applied ${label}${confidence}`, action: "Looks right" };
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
  // The group stays mounted across refreshes, so the row that took a settled row's place keeps focus and j and k go on
  // from it. Fresh rows from the server replace the list; a refresh that brings the same rows keeps the pages loaded since.
  const serverRows = JSON.stringify([initialItems, initialCursor]);
  const [seenRows, setSeenRows] = useState(serverRows);
  // Remnants of settled rows stay through the refresh their own step asked for, and leave with the one after it.
  const [settled, setSettled] = useState<Settled[]>([]);
  if (serverRows !== seenRows) {
    setSeenRows(serverRows);
    setItems(initialItems);
    setCursor(initialCursor);
    setSettled((current) => current.filter((r) => !r.survived).map((r) => ({ ...r, survived: true })));
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const list = useRef<HTMLUListElement>(null);
  // The rows the bulk step will mark, kept as they were when its confirm opened, so the list cannot change under the person.
  const [bulk, setBulk] = useState<{ open: boolean; rows: QueueItemView[] }>({ open: false, rows: [] });
  const timers = useRef<number[]>([]);
  useEffect(() => {
    // The array only grows in place, so the one read here holds every timer started later too.
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);
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
    if (!c || c.kind === "stop_review" || (c.kind === "held" && c.unlocksCustomer)) return false;
    const result =
      c.kind === "held"
        ? item.conversationId
          ? await callApi(`/api/inbox/${item.conversationId}/reply-type`, "POST", { replyTypeKey: null, expectedContextVersion: c.contextVersion })
          : { ok: false, error: "Open the person to decide.", code: null, details: null }
        : await callApi(`/api/reply-type-picks/${c.replyTypePickId}/acknowledge`, "POST");
    if (!result.ok) {
      const stop = result.code === "stop_review" ? stopHref(item, query) : null;
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
      const index = items.findIndex((i) => i.recordId === item.recordId);
      const text = settledText(item, ambiguous);
      // The last row of a list empties it, and the refresh below takes the list off the page with its remnant. The outcome
      // then lands off screen, so a toast says it too (DESIGN.md Feedback).
      const last = items.length === 1 && cursor === null;
      removeRows([item.recordId]);
      setSettled((current) => [
        ...current.filter((r) => r.recordId !== item.recordId),
        { recordId: item.recordId, index, text, href: item.conversationId ? rowHref(item, query) : null, survived: false },
      ]);
      timers.current.push(window.setTimeout(() => setSettled((current) => current.filter((r) => r.recordId !== item.recordId)), SETTLED_MS));
      announce(doneFor(item.classification?.kind === "held" ? ACCEPTED : LOOKS_RIGHT_DONE, item.personName));
      if (last) toast.success(text);
    }
    // Totals and the group the record moves to are the server's to say.
    router.refresh();
  }

  /** Applied picks the AI was at least 90 percent sure of. A held pick or a stop request needs a person's eyes, so it is never in here. */
  const confident = group === "classification" ? items.filter((i) => i.classification?.kind === "looks_right" && (i.classification.confidence ?? 0) >= 0.9) : [];

  /** Runs from the confirm step, which lists the rows it marks, so a person sees what N picks they sign off on. */
  async function markConfident() {
    if (rowBusy) return;
    setRowBusy("bulk");
    const done: string[] = [];
    for (const item of bulk.rows) {
      if (!(await settle(item))) break;
      done.push(item.recordId);
    }
    setRowBusy(null);
    if (done.length > 0) {
      removeRows(done);
      const text = `Marked ${countOf(done.length, "AI pick")} as looked at.`;
      announce(text);
      toast.success(text);
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

  // Real rows with the remnants of settled ones back at the spots they left.
  const rows: Array<{ item: QueueItemView } | { remnant: Settled }> = items.map((item) => ({ item }));
  for (const remnant of [...settled].sort((a, b) => a.index - b.index)) rows.splice(Math.min(Math.max(remnant.index, 0), rows.length), 0, { remnant });

  // The same frame as the lists below the queue (actions/page.tsx): the shell's section head with the lavender count (work
  // that waits for a person), help on an info mark where the name needs it, then one bordered list with hairlines between
  // the items. The head wraps, so the bulk button drops under the title on a phone instead of widening the page.
  return (
    <section id={`group-${group}`} aria-label={title} data-slot="queue-group" data-group={group} className="stack-group min-w-0 scroll-mt-4">
      <SectionHead
        title={title}
        count={formatCount(total)}
        countTone="waiting"
        countTestId={`queue-total-${group}`}
        help={description ? <InfoTip label={`About ${title}`}>{description}</InfoTip> : undefined}
        action={
          confident.length >= 2 ? (
            <Button variant="outline" size="sm" touch disabled={rowBusy !== null} onClick={() => setBulk({ open: true, rows: confident })} data-testid="mark-confident">
              {`Looks right: ${confident.length} sure picks`}
            </Button>
          ) : undefined
        }
      />
      {group === "classification" && (
        <ConfirmDialog
          open={bulk.open}
          onOpenChange={(open) => setBulk((current) => ({ ...current, open }))}
          title="Mark the sure picks as looked at"
          description="The AI applied these types at 90% or more. Marking them as looked at keeps each type and takes the rows off the queue."
          confirmLabel={`Mark ${formatCount(bulk.rows.length)} as looked at`}
          cancelLabel="Keep for review"
          pendingLabel="Marking…"
          onConfirm={markConfident}
        >
          <ul className="grid gap-1 text-sm" data-testid="mark-confident-list">
            {bulk.rows.map((item) => (
              <li key={item.recordId}>
                <span className="font-medium">{item.personName ?? "Unknown sender"}</span>
                <span className="text-muted-foreground">{`, ${typeLabel(item.classification?.name ?? null, item.classification?.groupKey ?? null, ambiguous) ?? "a type"}`}</span>
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
      <ul ref={list} className="divide-y rounded-lg border text-sm">
        {rows.map((entry) => {
          if ("remnant" in entry) {
            const r = entry.remnant;
            // Not a list row: j and k skip it, and its link sits in the tab order like any other link.
            return (
              <li key={`settled-${r.recordId}`} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-xs text-muted-foreground sm:min-h-0" data-testid="queue-settled">
                <span className="min-w-0 truncate">{r.text}</span>
                {r.href && (
                  <Link href={r.href} className="shrink-0 font-medium text-foreground underline-offset-4 hover:underline focus-ring max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
                    Open conversation
                  </Link>
                )}
              </li>
            );
          }
          const item = entry.item;
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
                <Time value={item.waitingSince.at} label={wait} className="shrink-0 text-xs text-muted-foreground tabular-nums" testId="queue-waiting" />
              </div>
              {item.snippet && <p className="truncate text-muted-foreground">{item.snippet}</p>}
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                {/* A stop request wraps on a phone: cut short, it would lose the sentence that says nothing stops yet. */}
                <span className={cn("min-w-0", stop ? "max-sm:text-pretty sm:truncate" : "truncate")}>
                  {detail}
                  {showAssignee && <span data-testid="queue-assignee">{` · ${item.assignee ? `Assigned to ${item.assignee.name ?? "a former member"}` : "Unassigned"}`}</span>}
                </span>
                {stop ? (
                  // Above the stretched link. It opens the thread with Stop contacting open; nothing is accepted here.
                  <Link
                    href={stop}
                    className={cn(buttonVariants({ variant: "outline", size: "sm", touch: true }), "relative z-10 shrink-0")}
                    aria-label={`${action}: ${item.personName ?? "the sender"}`}
                    data-testid="review-stop"
                  >
                    {action}
                  </Link>
                ) : (kind === "held" && item.conversationId && !item.classification?.unlocksCustomer) || kind === "looks_right" ? (
                  // Above the stretched link, so the click settles the row and does not open the thread.
                  <Button
                    variant="outline"
                    size="sm"
                    touch
                    className="relative z-10 shrink-0"
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
          Showing {formatCount(items.length)} of {formatCount(total)}
        </span>
        {cursor && (
          <Button variant="outline" size="sm" touch onClick={loadMore} disabled={busy}>
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
