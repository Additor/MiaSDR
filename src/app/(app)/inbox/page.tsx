import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState } from "@/components/shell/empty-state";
import { FilterChips } from "@/components/shell/filter-chips";
import { SearchField } from "@/components/shell/search-field";
import { ListPager } from "@/components/shell/list-pager";
import { ListSkeleton } from "@/components/shell/list-skeleton";
import { getOrgTimeZone } from "@/components/shell/org-time-zone";
import { PageHeader } from "@/components/shell/page-header";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { INBOX_PAGE_SIZE, inboxFilterOptions, listInbox, listScheduledInbox } from "@/contexts/conversations/application/inbox";
import { activeFilterCount, inboxHref, parseInboxParams, type InboxView } from "@/contexts/conversations/domain/inbox-filter";
import { getWorkQueueCounts, getWorkQueueExtras } from "@/contexts/conversations/actions/application/work-queue";
import { inboxDeps } from "@/contexts/conversations/infrastructure/composition";
import { workQueueDeps } from "@/contexts/conversations/actions/infrastructure/work-queue-composition";
import { requireOrgContext } from "@/contexts/identity/infrastructure/session";
import { cn } from "@/lib/utils";
import { toActor } from "@/shared/api";
import { ActiveFilters, FilterPanel } from "./filter-panel";
import { MoreViews } from "./more-views";
import { SearchAndFilters } from "./search-and-filters";
import { ConversationRow } from "./conversation-row";
import { groupByDayInZone, rowTimeLabel } from "./day-groups";
import { ListKeys } from "@/components/shell/list-keys";
import { ViewSwitch } from "@/components/shell/view-switch";

export const metadata: Metadata = { title: "Inbox" };

export default function InboxPage({ searchParams }: PageProps<"/inbox">) {
  return (
    <>
      <PageHeader
        title="Inbox"
        actions={
          <Suspense fallback={null}>
            <UnmatchedSendersLink />
          </Suspense>
        }
      />
      <div className="page stack-group">
        <Suspense fallback={<ListSkeleton label="Loading conversations" />}>
          <Conversations searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

/** Inbound mail from addresses that match no person waits on its own page; the header says how much. */
async function UnmatchedSendersLink() {
  await connection();
  const { openIdentityExceptions: open } = await getWorkQueueExtras(workQueueDeps(), toActor(await requireOrgContext()));
  return (
    <Link href="/inbox/unmatched" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-sm:h-11")} data-testid="unmatched-senders-link">
      Unmatched senders
      {open > 0 && (
        <span className="font-semibold tabular-nums" data-testid="unmatched-senders-count">
          {open}
          <span className="sr-only"> open</span>
        </span>
      )}
    </Link>
  );
}

/** The conversation views people open first sit in the chip row; the rest sit behind its More chip. */
const CHIP_VIEWS: Array<{ key: InboxView; label: string }> = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "important", label: "Important" },
];
const MORE_VIEWS: Array<{ key: InboxView; label: string }> = [
  { key: "sent", label: "Sent" },
  { key: "replied", label: "Replied" },
  { key: "ooo", label: "Out of office" },
  { key: "automated", label: "Automated" },
];

async function Conversations({ searchParams }: { searchParams: PageProps<"/inbox">["searchParams"] }) {
  await connection();
  const actor = toActor(await requireOrgContext());
  const params = parseInboxParams(await searchParams);
  const { view, query, page } = params;
  const deps = inboxDeps();
  const scheduled = view === "scheduled";
  // A list that fails to load must not take the page down with it: the sections, the views and the search stay, and the list
  // says what happened. The Actions count is a side line, so its failure only leaves the line out.
  const [loaded, counts] = await Promise.all([
    Promise.all([
      getOrgTimeZone(),
      inboxFilterOptions(deps, actor, params.leadIds),
      scheduled ? null : listInbox(deps, actor, params),
      scheduled ? listScheduledInbox(deps, actor, params) : null,
    ]).then(
      ([timeZone, options, listed, queued]) => ({ timeZone, options, listed, queued }),
      (error: unknown) => {
        console.error("The Inbox list did not load", error);
        return null;
      },
    ),
    getWorkQueueCounts(workQueueDeps(), actor).catch((error: unknown) => {
      console.error("The Actions count did not load", error);
      return null;
    }),
  ]);
  const { timeZone, options, listed, queued } = loaded ?? { timeZone: "UTC", options: null, listed: null, queued: null };
  const rows = listed?.rows ?? [];
  const total = (listed ?? queued)?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / INBOX_PAGE_SIZE));
  const narrowed = Boolean(query) || view !== "all" || activeFilterCount(params) > 0;
  const now = new Date();
  const link = (override: Partial<typeof params>) => inboxHref(params, override);
  // A thread opened from the list carries the list's view and filters, so its back link and "Next unread" stay in that list.
  const listQuery = inboxHref(params).split("?")[1];
  const threadHref = (id: string) => `/inbox/${id}${listQuery ? `?${listQuery}` : ""}`;
  const mailboxConnected = (options?.mailboxes.length ?? 0) > 0;

  const search = (
    <form className="flex min-w-48 flex-1 items-center" action="/inbox">
      {view !== "all" && <input type="hidden" name="view" value={view} />}
      {params.leadIds.map((id) => (
        <input key={id} type="hidden" name="lead" value={id} />
      ))}
      {params.leadQuery && <input type="hidden" name="lead" value={params.leadQuery} />}
      {params.campaignIds.map((id) => (
        <input key={id} type="hidden" name="campaign" value={id} />
      ))}
      {params.mailboxIds.map((id) => (
        <input key={id} type="hidden" name="mailbox" value={id} />
      ))}
      {params.subcategoryKeys.map((k) => (
        <input key={k} type="hidden" name="subcategory" value={k} />
      ))}
      {params.categoryKeys.map((k) => (
        <input key={k} type="hidden" name="category" value={k} />
      ))}
      {params.dateMode !== "all" && <input type="hidden" name="range" value={params.dateMode} />}
      {params.dateMode === "custom" && params.dateFrom && <input type="hidden" name="from" value={params.dateFrom} />}
      {params.dateMode === "custom" && params.dateTo && <input type="hidden" name="to" value={params.dateTo} />}
      <SearchField label="Search inbox" defaultValue={query} placeholder="Search sender, subject or any message" className="max-w-sm" />
    </form>
  );
  // What waits on a person is not a view of conversations. It has its own page, and this line says how much is there.
  const waiting = counts?.work.mine ?? 0;
  const status =
    waiting > 0 ? (
      <Link href="/actions" className="inline-flex min-h-8 items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline max-sm:min-h-11 sm:ml-auto" data-testid="waiting-in-actions">
        <span className="font-semibold text-sidebar-count tabular-nums">{waiting}</span> waiting in Actions
      </Link>
    ) : null;

  return (
    <>
      <ViewSwitch
        label="Inbox sections"
        items={[
          { href: scheduled ? link({ view: "all", page: 1 }) : link({ page: 1 }), label: "Conversations", active: !scheduled },
          { href: link({ view: "scheduled", page: 1 }), label: "Scheduled", active: scheduled },
        ]}
      />
      {!scheduled && (
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChips label="Conversation views" items={CHIP_VIEWS.map((v) => ({ href: link({ view: v.key, page: 1 }), label: v.label, active: v.key === view }))} />
          <MoreViews items={MORE_VIEWS.map((v) => ({ href: link({ view: v.key, page: 1 }), label: v.label, active: v.key === view }))} />
        </div>
      )}

      <SearchAndFilters count={activeFilterCount(params)} search={search} status={status} panel={options ? <FilterPanel params={params} options={options} /> : null} />
      {options && <ActiveFilters params={params} options={options} />}

      {!loaded && (
        <div role="alert" className="grid justify-items-start gap-2 py-8 text-sm" data-testid="inbox-load-failed">
          <p className="font-medium">{scheduled ? "The queued steps did not load" : "The conversations did not load"}</p>
          <p className="max-w-prose text-muted-foreground">Nothing was lost. Try again, and if it keeps failing, ask your admin to look at the server log.</p>
          <Link href={link({})} className={cn(buttonVariants({ variant: "outline" }), "max-sm:h-11")}>
            Try again
          </Link>
        </div>
      )}

      {loaded && view === "all" && !query && (listed?.automatedHidden ?? 0) > 0 && (
        <p className="text-sm text-muted-foreground">
          {listed?.automatedHidden} automated {listed?.automatedHidden === 1 ? "conversation is" : "conversations are"} hidden
          <span className="hidden sm:inline"> (auto-replies, no-reply senders, DMARC reports, bounce notices)</span>.{" "}
          <Link href={link({ view: "automated", page: 1 })} className="inline-flex min-h-8 items-center underline underline-offset-4 max-sm:min-h-11">
            Show automated
          </Link>
        </p>
      )}

      {!loaded ? null : total === 0 ? (
        <EmptyState
          title={scheduled ? "Nothing is queued" : narrowed ? "No conversations match" : "No replies yet"}
          description={
            scheduled
              ? "Next steps appear here while a campaign step or an after-reply follow-up is waiting to send."
              : narrowed
                ? "Try a different search or filter."
                : mailboxConnected
                  ? "Replies appear here once someone writes back to a campaign email. Start or check a campaign to get messages out."
                  : "Replies appear here once a mailbox is connected and someone writes back. Connect a Google Workspace mailbox first."
          }
          action={scheduled ? { label: "Open campaigns", href: "/campaigns" } : narrowed ? { label: "Clear search and filters", href: "/inbox" } : mailboxConnected ? { label: "Open campaigns", href: "/campaigns" } : { label: "Connect a mailbox", href: "/settings/mailboxes" }}
        />
      ) : (
        <>
          {queued ? (
            <Table>
              <TableCaption className="text-left">Queued in the campaign. Read-only: change timing or stop a step from the campaign or the lead&apos;s page.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Next step</TableHead>
                  <TableHead className="hidden sm:table-cell">Source</TableHead>
                  <TableHead className="hidden sm:table-cell">Mailbox</TableHead>
                  <TableHead className="text-right">Sends at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queued.rows.map((row) => (
                  <TableRow key={`${row.kind}-${row.id}`}>
                    <TableCell className="max-w-56 truncate font-medium">
                      {row.personName ?? row.personEmail ?? "Unknown lead"}
                      {row.personName && row.personEmail && <div className="truncate text-xs font-normal text-muted-foreground">{row.personEmail}</div>}
                    </TableCell>
                    <TableCell className="max-w-md truncate">
                      <span>{row.stepLabel}</span>
                      {row.subject && <span className="text-muted-foreground">{` ${row.subject}`}</span>}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="outline">{row.kind === "campaign" ? "Campaign" : "After a reply"}</Badge> {row.sourceName}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{row.mailbox ?? row.channel}</TableCell>
                    <TableCell className="text-right whitespace-nowrap text-muted-foreground"><Time value={row.dueAt} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="grid gap-4">
              {groupByDayInZone(rows, (r) => r.lastMessageAt, now, timeZone).map((group) => (
                <section key={group.group} aria-labelledby={`day-${group.group}`} className="grid gap-1.5">
                  <h2 id={`day-${group.group}`} data-slot="day-divider" className="px-1 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </h2>
                  <ul className="divide-y rounded-lg border text-sm">
                    {group.rows.map((row) => (
                      <ConversationRow key={row.conversationId} row={row} href={threadHref(row.conversationId)} time={rowTimeLabel(row.lastMessageAt, group.group, timeZone)} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
          {!queued && (
            <>
              <ListKeys />
              <p className="hidden text-xs text-muted-foreground sm:block">Keyboard: j and k move between conversations, Enter opens the highlighted one.</p>
            </>
          )}
          <ListPager total={total} page={page} pageCount={pageCount} noun={scheduled ? ["queued step", "queued steps"] : ["conversation", "conversations"]} hrefFor={(p) => link({ page: p })} />
        </>
      )}
    </>
  );
}
