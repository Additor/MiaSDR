"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDownIcon, MoreHorizontalIcon } from "lucide-react";
import { Fragment, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { BulkBar } from "@/components/shell/bulk-bar";
import { ListPager } from "@/components/shell/list-pager";
import { RowLink, rowLinkClasses } from "@/components/shell/row-link";
import { useBarScrollPadding, useBulkStep, useSelection } from "@/components/shell/selection";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LEAD_STATE_LABELS } from "@/contexts/outreach/domain/lead-status";
import type { LeadActivity } from "@/contexts/outreach/application/read-lead-activity";
import { isFilterActive, leadFilterParams, lifecycleOf, matchingSelection, selectionExport, type LeadFilter, type LeadSort, type LeadSortKey } from "@/contexts/people/domain/lead-filter";
import { callApi } from "@/app/_lib/api-client";
import { formatCount } from "@/shared/format-number";
import { CreateDealsBulkDialog } from "@/app/(app)/crm/_components/create-deal-dialog";
import { LeadStatusToken } from "@/app/(app)/_components/person/lead-status-token";
import { personHref } from "@/app/(app)/_components/person/person-href";
import { ReachIcons } from "@/app/(app)/_components/person/reach-icons";
import type { DealMemberOption, DealStageList } from "@/app/(app)/crm/_components/deal-form";
import { bulkActionModel, clearsSelectionOnKey, type BulkMenuItemId } from "../_lib/bulk-actions";
import { useLeadColumns } from "./columns-menu";
import type { OptionalColumn } from "../_lib/list-columns";
import { leadHref, listQueryOf } from "../[id]/list-context";
import { leadsHref } from "../_lib/list-url";

export interface LeadListRow {
  id: string;
  fullName: string | null;
  email: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  /** ISO timestamps. The table prints them in the organization's zone. */
  createdAt: string;
  updatedAt: string;
  /** `contact` once a deal was created from the person. Only a list with `lifecycle=all` or `contact` holds one. */
  lifecycle: "lead" | "contact";
  activity: LeadRowActivity;
}

/** Status, reach and contact points from `readLeadActivity`, the read the lead page uses too. Dates cross to the client as Dates. */
export type LeadRowActivity = LeadActivity;

/** The one empty word for a lead nothing went out to, in the column and in the phone line. */
const NOT_CONTACTED = "Not contacted";

const NO_IDS: string[] = [];

/** What the list counts: leads by default, contacts, or people when it shows both. */
function listNoun(lifecycle: "lead" | "contact" | "all", n: number): string {
  if (lifecycle === "contact") return n === 1 ? "contact" : "contacts";
  if (lifecycle === "all") return n === 1 ? "person" : "people";
  return n === 1 ? "lead" : "leads";
}

const SIZES = [25, 50, 100, 200].map((n) => ({ value: String(n), label: `${n} per page` }));

interface DeleteResult {
  deleted: number;
  blockedCount: number;
  kept: Array<{ reason: string; count: number; line: string }>;
  retryIds: string[];
  suggestDoNotContact: boolean;
}

type Pending = { kind: "selected"; ids: string[] } | { kind: "filter" } | null;

/**
 * Column order. `sortKey` makes the header a sort link; Reach, Status and Last contact have none, because a sort
 * over them would aggregate every lead of the organization. Those three give way to a stacked line under the name on
 * narrow screens, and the other columns scroll. The Status column keeps the id `campaign`, so saved cookies still apply.
 */
const COLUMNS: Array<{ id: "name" | OptionalColumn; label: string; sortKey?: LeadSortKey; status?: boolean }> = [
  { id: "name", label: "Name", sortKey: "name" },
  { id: "contact", label: "Reach", status: true },
  { id: "campaign", label: "Status", status: true },
  { id: "lastContact", label: "Last contact", status: true },
  { id: "email", label: "Email", sortKey: "email" },
  { id: "title", label: "Title", sortKey: "title" },
  { id: "company", label: "Company", sortKey: "company" },
  { id: "added", label: "Added", sortKey: "created" },
];

export function LeadsTableView(props: {
  rows: LeadListRow[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  filter: LeadFilter;
  sort: LeadSort;
  userId: string;
  /** The server's clock for this render. Relative times print against it. */
  now: string;
  /** Extra bulk actions, rendered in the selection bar. They read the selection with `useSelection`. */
  bulkActions?: ReactNode;
  /** Stages and owner choices for the bulk Create deals dialog. */
  deals: { stages: DealStageList; members: DealMemberOption[] };
}) {
  const { rows, total, page, pageCount, pageSize, filter, sort, bulkActions, userId, now, deals } = props;
  const { columns } = useLeadColumns();
  const shows = (id: "name" | OptionalColumn) => id === "name" || columns.includes(id);
  const router = useRouter();
  const { selectedIds: ids, isSelected, select, clear } = useSelection();
  const [pending, setPending] = useState<Pending>(null);
  const [gathering, setGathering] = useState(false);
  const { error: gatherError, setError: setGatherError, begin } = useBulkStep(ids.length);
  // The ids the Create deals dialog works on, fixed when it opens: the dialog reloads its preview for a new array.
  const [dealIds, setDealIds] = useState<string[] | null>(null);
  const lifecycle = lifecycleOf(filter);
  const bar = useRef<HTMLDivElement>(null);
  useBarScrollPadding(bar, ids.length > 0);

  const filtered = isFilterActive(filter);
  const allOnPage = rows.length > 0 && rows.every((r) => isSelected(r.id));
  const someOnPage = rows.some((r) => isSelected(r.id));
  const pageIds = rows.map((r) => r.id);
  const at = (overrides: { sort?: LeadSort; page?: number; size?: number }) =>
    leadsHref({ filter, sort: overrides.sort ?? sort, page: overrides.page, size: overrides.size ?? pageSize });
  const offPage = ids.some((id) => !pageIds.includes(id));
  const matching = matchingSelection(ids.length, total);
  const exporting = selectionExport(ids);
  const exportCap = `An export covers up to ${formatCount(exporting.ids.length)} leads. Filter the list to export the rest.`;
  const exportSelected = `/api/leads/export?${new URLSearchParams({ ids: exporting.ids.join(",") }).toString()}`;
  const model = bulkActionModel({ selectedCount: ids.length, total, filterActive: filtered, canSelectAll: matching.canSelectAll, lifecycle });
  const menuLabels: Record<BulkMenuItemId, string> = {
    selectAll:
      matching.reach < total
        ? `Select the first ${formatCount(matching.reach)} of ${formatCount(total)}`
        : `Select all ${formatCount(total)} ${filtered ? "matching" : listNoun(lifecycle, total)}`,
    createDeals: "Create deals",
    deleteSelected: "Delete selected",
    deleteMatching: `Delete all ${formatCount(total)} matching`,
  };
  function runMenuItem(id: BulkMenuItemId) {
    if (id === "selectAll") void selectAllMatching();
    else if (id === "createDeals") setDealIds(ids);
    else if (id === "deleteSelected") setPending({ kind: "selected", ids });
    else setPending({ kind: "filter" });
  }
  /** Esc in the table drops the selection, so a keyboard user does not have to tab to Clear selection. */
  function onTableKeyDown(event: KeyboardEvent) {
    if (clearsSelectionOnKey({ key: event.key, selectedCount: ids.length, defaultPrevented: event.defaultPrevented })) clear();
  }

  function toggleAll(checked: boolean) {
    select(pageIds, checked);
  }
  function toggle(id: string, checked: boolean) {
    select([id], checked);
  }
  function sortFor(key: LeadSortKey): LeadSort {
    if (sort.key === key) return { key, dir: sort.dir === "asc" ? "desc" : "asc" };
    return { key, dir: key === "created" ? "desc" : "asc" };
  }

  /** Ticks every lead that matches the filter, on all pages, so Add to campaign and Delete selected reach them. */
  async function selectAllMatching() {
    const current = begin();
    setGathering(true);
    setGatherError(null);
    const result = await callApi<{ ids: string[]; capped: boolean }>(`/api/leads/ids?${leadFilterParams({ ...filter, ids: undefined }).toString()}`, "GET");
    setGathering(false);
    // Cleared while the request ran: the answer belongs to a selection the person dropped.
    if (!current()) return;
    if (!result.ok || !result.data) {
      setGatherError(`${result.error ?? "Could not read the matching leads."} Try again, or tick rows by hand.`);
      return;
    }
    select(result.data.ids, true);
  }

  async function confirmDelete() {
    if (!pending) return;
    const body = pending.kind === "selected" ? { ids: pending.ids } : { filter: Object.fromEntries(Object.entries({ ...filter, ids: undefined }).filter(([, v]) => v !== undefined)), confirmCount: total };
    const result = await callApi<DeleteResult>("/api/leads/delete", "POST", body);
    // ConfirmDialog shows the thrown message and keeps the dialog open.
    if (!result.ok || !result.data) throw new Error(result.error ?? "The leads could not be deleted. Try again.");
    clear();
    announceDelete(result.data);
    router.refresh();
  }

  /** One line per reason the server kept leads for, and a retry of the leads that only met a concurrent change. */
  function announceDelete({ deleted, blockedCount, kept, retryIds, suggestDoNotContact }: DeleteResult) {
    const done = `Deleted ${deleted} ${deleted === 1 ? "lead" : "leads"}.`;
    if (blockedCount === 0) {
      toast.success(done);
      return;
    }
    toast.warning(`${done} Kept ${blockedCount}.`, {
      description: (
        <ul className="space-y-0.5">
          {kept.map((k) => (
            <li key={k.reason}>{k.line}</li>
          ))}
          {suggestDoNotContact && <li>Mark a kept lead do not contact to stop all outreach to it.</li>}
        </ul>
      ),
      duration: retryIds.length > 0 ? Infinity : undefined,
      action: retryIds.length > 0 ? { label: "Try again", onClick: () => void retryDelete(retryIds) } : undefined,
    });
  }

  async function retryDelete(ids: string[]) {
    const result = await callApi<DeleteResult>("/api/leads/delete", "POST", { ids });
    if (!result.ok || !result.data) {
      toast.error(result.error ?? "The leads could not be deleted. Try again.");
      return;
    }
    announceDelete(result.data);
    router.refresh();
  }

  return (
    <>
      {/* Esc inside the table clears the selection; the bar sits after the table. */}
      <div className="min-w-0" onKeyDown={onTableKeyDown}>
        <ScrollableTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox checked={allOnPage} indeterminate={!allOnPage && someOnPage} onCheckedChange={(checked) => toggleAll(Boolean(checked))} aria-label="Select all leads on this page" />
                </TableHead>
                {COLUMNS.filter((column) => shows(column.id)).map((column) => (
                  <TableHead
                    key={column.id}
                    className={column.status ? "max-md:hidden" : undefined}
                    aria-sort={column.sortKey && sort.key === column.sortKey ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {column.sortKey ? (
                      <Link href={at({ sort: sortFor(column.sortKey) })} className="inline-flex items-center gap-1 hover:underline" data-sort-key={column.sortKey}>
                        {column.label}
                        <span aria-hidden className="text-muted-foreground">
                          {sort.key === column.sortKey ? (sort.dir === "asc" ? "\u25B2" : "\u25BC") : ""}
                        </span>
                      </Link>
                    ) : (
                      column.label
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((lead) => (
                <TableRow key={lead.id} data-state={isSelected(lead.id) ? "selected" : undefined} className={rowLinkClasses}>
                  <TableCell className="relative z-10">
                    <Checkbox checked={isSelected(lead.id)} onCheckedChange={(checked) => toggle(lead.id, Boolean(checked))} aria-label={`Select ${lead.fullName ?? lead.email ?? "lead"}`} />
                  </TableCell>
                  <TableCell className="font-medium">
                    {/* A lead's link carries the list context; a contact page has none. */}
                    <RowLink href={lead.lifecycle === "lead" ? leadHref(lead.id, listQueryOf(at({}))) : personHref(lead.id, lead.lifecycle)}>
                      {lead.fullName ?? <span className="text-muted-foreground">Unnamed</span>}
                    </RowLink>
                    {lifecycle === "all" && lead.lifecycle === "contact" && (
                      <Badge variant="outline" className="ml-2" data-testid="contact-chip">
                        Contact
                      </Badge>
                    )}
                    <StatusLine lead={lead} now={now} />
                  </TableCell>
                  {shows("contact") && (
                    <TableCell className="max-md:hidden">
                      <ReachIcons reach={lead.activity.reach} contact={lead.activity.contact} person={lead.fullName ?? lead.email ?? "this person"} />
                    </TableCell>
                  )}
                  {shows("campaign") && (
                    <TableCell className="max-md:hidden">
                      {/* A contact carries no lead status; its deals live in the CRM. */}
                      {lead.activity.status && (
                        <div className="grid justify-items-start gap-0.5">
                          <LeadStatusToken status={lead.activity.status} compact className="relative z-10" />
                          {lead.activity.status.enrollment && <span className="max-w-48 truncate text-xs text-muted-foreground" data-testid="lead-status-campaign">{lead.activity.status.enrollment.campaignName}</span>}
                        </div>
                      )}
                    </TableCell>
                  )}
                  {shows("lastContact") && (
                    <TableCell className="max-md:hidden">
                      {lead.activity.status &&
                        (lead.activity.status.lastContactAt ? (
                          <Time value={lead.activity.status.lastContactAt} relativeTo={now} className="relative z-10 cursor-default" />
                        ) : (
                          <span className="text-muted-foreground">{NOT_CONTACTED}</span>
                        ))}
                    </TableCell>
                  )}
                  {shows("email") && <TableCell>{lead.email ?? <span className="text-muted-foreground">LinkedIn only</span>}</TableCell>}
                  {shows("title") && <TableCell>{lead.title ?? ""}</TableCell>}
                  {shows("company") && (
                    <TableCell>
                      {lead.companyName ?? lead.companyDomain ?? (
                        <span className="text-muted-foreground">No company</span>
                      )}
                    </TableCell>
                  )}
                  {shows("added") && (
                    <TableCell className="text-muted-foreground">
                      <Time value={lead.createdAt} dateOnly />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollableTable>
      </div>

      <ListPager
        total={total}
        page={page}
        pageCount={pageCount}
        noun={[listNoun(lifecycle, 1), listNoun(lifecycle, 2)]}
        hrefFor={(p) => at({ page: p })}
        size={
          <Select items={SIZES} value={String(pageSize)} onValueChange={(value) => router.push(at({ size: Number(value) }))}>
            <SelectTrigger className="w-36" aria-label="Leads per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SIZES.map((size) => (
                <SelectItem key={size.value} value={size.value}>
                  {size.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {/* The bar sits after the table, so ticking the first row never moves the rows above it. */}
      <BulkBar
        barRef={bar}
        count={ids.length}
        status={gathering ? "Selecting all matching leads…" : `${formatCount(ids.length)} selected${offPage ? ", across pages" : ""}.`}
        note={matching.capped ? `The first ${formatCount(matching.reach)} of ${formatCount(total)} matching leads. Narrow the filter to reach the rest.` : undefined}
        error={gatherError}
        actions={
          (model.visible.includes("addToCampaign") || model.visible.includes("export")) && (
            <>
              {model.visible.includes("addToCampaign") && bulkActions}
              {model.visible.includes("export") &&
                (exporting.capped ? (
                  <Tooltip>
                    <TooltipTrigger delay={150} render={<a href={exportSelected} download className={buttonVariants({ variant: "outline" })} />}>
                      {exporting.label}
                      <span className="sr-only">, {exportCap}</span>
                    </TooltipTrigger>
                    <TooltipContent className="block max-w-72 text-left leading-relaxed">{exportCap}</TooltipContent>
                  </Tooltip>
                ) : (
                  <a href={exportSelected} download className={buttonVariants({ variant: "outline" })}>
                    {exporting.label}
                  </a>
                ))}
            </>
          )
        }
        onClear={model.visible.includes("clear") ? clear : undefined}
        more={
          model.visible.includes("more") && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" className="max-md:size-11" />}>
                <MoreHorizontalIcon aria-hidden className="md:hidden" />
                <span className="max-md:sr-only">More actions</span>
                <ChevronDownIcon aria-hidden className="max-md:hidden" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" className="w-auto min-w-56">
                {model.menu.map((item, index) => (
                  <Fragment key={item.id}>
                    {item.destructive && !model.menu[index - 1]?.destructive && index > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem variant={item.destructive ? "destructive" : "default"} className="max-md:min-h-11" onClick={() => runMenuItem(item.id)}>
                      {menuLabels[item.id]}
                    </DropdownMenuItem>
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={
          pending?.kind === "filter"
            ? `Delete ${formatCount(total)} matching leads?`
            : `Delete ${pending?.kind === "selected" ? formatCount(pending.ids.length) : 0} selected ${pending?.kind === "selected" && pending.ids.length === 1 ? "lead" : "leads"}?`
        }
        description={`${
          pending?.kind === "filter" ? `This deletes every lead that matches the current search and filters (${leadFilterParams({ ...filter, ids: undefined }).toString().replace(/&/g, ", ")}), on all pages. ` : ""
        }Leads that were already messaged, sit in a running or paused campaign or have history, such as replies, stay. Mark those do not contact instead. Deleting cannot be undone.`}
        confirmLabel={deleteLabel(pending?.kind === "filter" ? total : pending?.kind === "selected" ? pending.ids.length : 0)}
        pendingLabel="Deleting…"
        destructive
        onConfirm={confirmDelete}
      />

      <CreateDealsBulkDialog
        open={dealIds !== null}
        onOpenChange={(open) => !open && setDealIds(null)}
        ids={dealIds ?? NO_IDS}
        stages={deals.stages}
        members={deals.members}
        currentUserId={userId}
        onDone={clear}
      />
    </>
  );
}

/** The delete confirm names what it deletes: "Delete lead" or "Delete 12 leads". */
const deleteLabel = (count: number) => (count === 1 ? "Delete lead" : `Delete ${formatCount(count)} leads`);

/** The narrow-screen stand-in for the Reach, Status and Last contact columns: one line under the name. */
function StatusLine({ lead, now }: { lead: LeadListRow; now: string }) {
  const { contact, reach, status } = lead.activity;
  const channels = reach.doNotContact
    ? ["Do not contact"]
    : [contact.email ? (reach.email.state === "suppressed" ? "Email suppressed" : "Email") : null, contact.linkedin ? "LinkedIn" : null].filter((name): name is string => name !== null);
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs font-normal text-muted-foreground md:hidden" data-testid="lead-status-line">
      <span>{channels.length > 0 ? channels.join(", ") : "No channel"}</span>
      {status && <span>{status.enrollment ? `${LEAD_STATE_LABELS[status.state]}, ${status.enrollment.campaignName}` : LEAD_STATE_LABELS[status.state]}</span>}
      {status && <span>{status.lastContactAt ? <Time value={status.lastContactAt} relativeTo={now} className="relative z-10" /> : NOT_CONTACTED}</span>}
    </div>
  );
}
