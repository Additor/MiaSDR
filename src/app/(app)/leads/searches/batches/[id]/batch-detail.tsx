"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Fragment, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { StatusBadge } from "@/components/shell/status-badge";
import { useOrgTimeZone } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { batchRowActions, hasActiveSearch, searchNotice, searchStatusLabel, type BatchRowActionId, type SearchAction, type SearchStatus } from "@/contexts/outreach/linkedin/domain/linkedin-search";
import { runNowConfirmation, searchableLeft } from "@/contexts/outreach/linkedin/domain/linkedin-search-capacity";
import { callApi } from "@/app/_lib/api-client";
import { cn } from "@/components/ui/utils";
import { capacityReturnText } from "../../capacity-return";
import { useActiveRefresh } from "../../use-active-refresh";
import { SearchCapacityCard, type CapacityCardData } from "../../search-capacity-card";
import { statusSummary } from "../batches-panel";

interface Detail {
  id: string;
  name: string;
  queries: number;
  statuses: Record<string, number>;
  found: number;
  imported: number;
  campaign: { id: string; name: string } | null;
  accountNames: string[];
  maxResults: number;
  rowsTotal: number | null;
  rowsRejected: number | null;
  rejections: Array<{ row: number; reason: string }>;
  items: Array<{ id: string; url: string; companyName: string | null; status: string; found: number; maxResults: number; imported: number; lastError: string | null; sourceRow: number | null; rerunCount: number }>;
}

const TOUCH = "max-sm:h-11 max-sm:px-4";
const KEEP_NOTE = "People already added to Leads, and leads already in a campaign, are kept.";

/** A destructive action that waits for a confirmation. Adding searches has its own dialog, because it takes input. */
/** Searches that "Run now" makes due. A search waiting for the daily limit stays where it is. */
const RUNNABLE = ["queued", "paused"];

type Item = Detail["items"][number];
const itemName = (i: Item) => i.companyName ?? (i.sourceRow ? `Row ${i.sourceRow}` : "Added search");

type Danger =
  | { kind: "remove"; ids: string[] }
  | { kind: "results"; ids: string[] | null }
  | { kind: "batch" }
  | { kind: "cancel"; id: string; name: string };

interface Reply {
  error?: string;
}

export function BatchDetail({ batch, capacity, canManage }: { batch: Detail; capacity: CapacityCardData; canManage: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const timeZone = useOrgTimeZone();
  const [danger, setDanger] = useState<Danger | null>(null);
  const [runAsk, setRunAsk] = useState<{ ids: string[] | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const failed = batch.statuses.failed ?? 0;
  const due = (batch.statuses.queued ?? 0) + (batch.statuses.paused ?? 0);
  const capacityReturns = capacityReturnText(capacity.nextReturnAt, timeZone);
  const picked = batch.items.filter((i) => selected.has(i.id)).map((i) => i.id);
  const allTicked = batch.items.length > 0 && picked.length === batch.items.length;
  const someTicked = picked.length > 0 && !allTicked;

  // Pages arrive in the background, so the batch refreshes itself while a search works.
  useActiveRefresh(hasActiveSearch(batch.items.map((i) => i.status)));

  function closeAdd() {
    if (busy) return;
    setAdding(false);
    setProblem(null);
    setPasted("");
  }

  async function rerun(ids?: string[]) {
    const result = await callApi<{ rerun: number }>(`/api/linkedin/search-batches/${batch.id}/rerun`, "POST", ids ? { ids } : {});
    if (!result.ok) toast.error(result.error ?? "Could not queue the searches again. Try again.");
    else toast.success(result.data?.rerun ? `${result.data.rerun.toLocaleString("en-US")} ${result.data.rerun === 1 ? "search" : "searches"} queued again.` : "No failed searches to queue.");
    router.refresh();
  }

  /** The confirmed "Run now" and "Run selected". A failure throws, so ConfirmDialog keeps the dialog open and shows the message. */
  async function confirmRun() {
    if (!runAsk) return;
    const result = await callApi<{ queued: number }>(`/api/linkedin/search-batches/${batch.id}/run`, "POST", runAsk.ids ? { ids: runAsk.ids } : {});
    if (!result.ok) throw new Error(result.error ?? "Could not run the searches. Try again.");
    toast.success(result.data?.queued ? `${result.data.queued.toLocaleString("en-US")} ${result.data.queued === 1 ? "search is" : "searches are"} ready to run. Each account still reads within its daily limit.` : "No paused or queued searches to run.");
    setSelected(new Set());
    router.refresh();
  }

  async function runOne(id: string) {
    const result = await callApi<{ queued: number }>(`/api/linkedin/search-batches/${batch.id}/run`, "POST", { ids: [id] });
    if (!result.ok) toast.error(result.error ?? "Could not run the search. Try again.");
    else toast.success(result.data?.queued ? "The search is ready to run. Its account still reads within its daily limit." : "That search is not paused or queued.");
    router.refresh();
  }

  async function act(id: string, action: SearchAction) {
    const result = await callApi(`/api/linkedin/searches/${id}/action`, "POST", { action });
    if (!result.ok) toast.error(result.error ?? "Could not change the search. Try again.");
    router.refresh();
  }

  function onRowAction(item: Item, action: BatchRowActionId) {
    if (action === "run") void runOne(item.id);
    else if (action === "rerun") void rerun([item.id]);
    else if (action === "cancel") setDanger({ kind: "cancel", id: item.id, name: itemName(item) });
    else if (action === "remove") setDanger({ kind: "remove", ids: [item.id] });
    else void act(item.id, action);
  }

  async function addSearches() {
    setBusy(true);
    setProblem(null);
    const result = await callApi<{ added: number; alreadyInBatch: number; alreadyQueued: number; duplicatesInList: number; rejectedCount: number }>(`/api/linkedin/search-batches/${batch.id}/queries`, "POST", { urls: pasted.split(/\r?\n/) });
    setBusy(false);
    if (!result.ok) {
      setProblem([result.error, ...result.issues.slice(0, 5).map((i) => i.message)].filter(Boolean).join(" "));
      return;
    }
    if (result.data) {
      const d = result.data;
      const skipped = [d.rejectedCount && `${d.rejectedCount} refused`, d.duplicatesInList && `${d.duplicatesInList} repeated`, d.alreadyInBatch && `${d.alreadyInBatch} already in the batch`, d.alreadyQueued && `${d.alreadyQueued} already queued`].filter(Boolean);
      toast.success(`${d.added.toLocaleString("en-US")} ${d.added === 1 ? "search" : "searches"} queued${skipped.length ? `, ${skipped.join(", ")}` : ""}.`);
    }
    setAdding(false);
    setPasted("");
    setSelected(new Set());
    router.refresh();
  }

  /** Runs the confirmed action. A failure throws, so ConfirmDialog keeps the dialog open and shows the message. */
  async function confirmDanger() {
    if (!danger) return;
    let result;
    if (danger.kind === "remove") {
      result = await callApi<{ removed: number; resultsRemoved: number }>(`/api/linkedin/search-batches/${batch.id}/queries`, "DELETE", { ids: danger.ids });
      if (result.ok && result.data) toast.success(`Removed ${result.data.removed.toLocaleString("en-US")} ${result.data.removed === 1 ? "search" : "searches"} and ${result.data.resultsRemoved.toLocaleString("en-US")} stored ${result.data.resultsRemoved === 1 ? "result" : "results"}.`);
    } else if (danger.kind === "results") {
      result = await callApi<{ searches: number; resultsRemoved: number }>(`/api/linkedin/search-batches/${batch.id}/leads`, "DELETE", danger.ids ? { ids: danger.ids } : { all: true });
      if (result.ok && result.data) toast.success(`Deleted ${result.data.resultsRemoved.toLocaleString("en-US")} stored ${result.data.resultsRemoved === 1 ? "result" : "results"} of ${result.data.searches.toLocaleString("en-US")} ${result.data.searches === 1 ? "search" : "searches"}.`);
    } else if (danger.kind === "cancel") {
      result = await callApi(`/api/linkedin/searches/${danger.id}/action`, "POST", { action: "cancel" });
    } else {
      result = await callApi<Reply>(`/api/linkedin/search-batches/${batch.id}`, "DELETE");
      if (result.ok) toast.success("Batch deleted.");
    }
    if (!result.ok) throw new Error([result.error, ...result.issues.slice(0, 5).map((i) => i.message)].filter(Boolean).join(" "));
    setSelected(new Set());
    if (danger.kind === "batch") router.push("/leads/searches/batches");
    else router.refresh();
  }

  const toggle = (id: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggleAll = (on: boolean) => setSelected(on ? new Set(batch.items.map((i) => i.id)) : new Set());

  const runDue = runAsk?.ids ? batch.items.filter((i) => runAsk.ids?.includes(i.id) && RUNNABLE.includes(i.status)).length : due;
  const runConfirmation = runNowConfirmation({
    due: runDue,
    left: searchableLeft(capacity.accounts),
    accounts: capacity.accounts.filter((a) => a.restrictedUntil === null).length,
    resetsAt: capacityReturnText(capacity.dayResetsAt, timeZone) ?? "00:00 UTC",
  });

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div role="group" aria-label="Run" className="flex flex-wrap gap-2">
          <Button variant="outline" className={TOUCH} onClick={() => setAdding(true)}>
            Add searches
          </Button>
          <Button className={TOUCH} disabled={due === 0} onClick={() => setRunAsk({ ids: null })}>
            Run now
          </Button>
          {failed > 0 && (
            <Button variant="outline" className={TOUCH} onClick={() => rerun()}>
              Rerun {failed} failed
            </Button>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" className={TOUCH} />}>
            Data
            <ChevronDownIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-48">
            <DropdownMenuItem render={<a href={`/api/linkedin/search-batches/${batch.id}/results`} download />}>Download results</DropdownMenuItem>
            {canManage && (
              <>
                <DropdownMenuItem onClick={() => setDanger({ kind: "results", ids: null })}>Delete stored results</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDanger({ kind: "batch" })}>
                  Delete batch
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <SearchCapacityCard capacity={capacity} />

      <section className="stack-group border-t pt-group">
        <div className="stack-field">
          <h2 className="text-sm font-semibold">
            {batch.queries.toLocaleString("en-US")} {batch.queries === 1 ? "search" : "searches"}, {batch.found.toLocaleString("en-US")} people found, {batch.imported.toLocaleString("en-US")} in leads
          </h2>
          <p className="text-sm text-muted-foreground">
            {statusSummary(batch.statuses)}. Up to {batch.maxResults.toLocaleString("en-US")} people per search. {batch.campaign ? `Added to ${batch.campaign.name}.` : "Leads only."}{" "}
            {batch.accountNames.length > 0 ? `Accounts: ${batch.accountNames.join(", ")}.` : "Any connected account."}
          </p>
        </div>
        {batch.rowsRejected ? (
          <div className="text-sm" data-testid="batch-rejections">
            <p className="font-medium">
              {batch.rowsRejected.toLocaleString("en-US")} of {(batch.rowsTotal ?? 0).toLocaleString("en-US")} rows were refused
            </p>
            <ul className="list-disc pl-5 text-muted-foreground">
              {batch.rejections.slice(0, 10).map((r) => (
                <li key={r.row}>
                  Row {r.row}: {r.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {picked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="batch-selection">
          <span>{picked.length.toLocaleString("en-US")} selected</span>
          <Button size="sm" variant="outline" className={TOUCH} onClick={() => setRunAsk({ ids: picked })}>
            Run selected
          </Button>
          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" variant="outline" className={TOUCH} />}>
                More
                <ChevronDownIcon aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-auto min-w-48">
                <DropdownMenuItem onClick={() => setDanger({ kind: "results", ids: picked })}>Delete stored results</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDanger({ kind: "remove", ids: picked })}>
                  Remove selected
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button size="sm" variant="ghost" className={TOUCH} onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      <ScrollableTable className="max-sm:hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <SelectAll checked={allTicked} indeterminate={someTicked} onChange={toggleAll} />
              </TableHead>
              <TableHead>Search</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Found</TableHead>
              <TableHead className="text-right">In leads</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batch.items.map((i) => (
              <TableRow key={i.id}>
                <TableCell>
                  <Checkbox aria-label={`Select ${itemName(i)}`} checked={selected.has(i.id)} onCheckedChange={(on) => toggle(i.id, on === true)} />
                </TableCell>
                <TableCell className="max-w-72">
                  <p className="font-medium">{itemName(i)}</p>
                  <p className="truncate text-xs text-muted-foreground" title={i.url}>
                    {i.url.replace(/^https:\/\/www\.linkedin\.com/, "")}
                  </p>
                </TableCell>
                <TableCell className="max-w-64 whitespace-normal">
                  <RowStatus item={i} capacityReturns={capacityReturns} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {i.found.toLocaleString("en-US")} / {i.maxResults.toLocaleString("en-US")}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <InLeads item={i} />
                </TableCell>
                <TableCell className="text-right">
                  <RowActions item={i} canRemove={canManage} onAction={onRowAction} className="justify-end" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollableTable>

      {/* Below sm each search is a card, so Found, In leads and the actions stay reachable without scrolling sideways. */}
      <div className="grid grid-cols-1 gap-3 sm:hidden" data-testid="batch-cards">
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <Checkbox checked={allTicked} indeterminate={someTicked} onCheckedChange={(on) => toggleAll(on === true)} className={INDETERMINATE} />
          Select all searches
        </label>
        {/* One column that may shrink to the screen: an implicit `auto` column is as wide as the longest search URL. */}
        <ul className="grid grid-cols-1 gap-3">
          {batch.items.map((i) => (
            <li key={i.id} className="grid gap-2 rounded-lg border p-3" data-testid="batch-card">
              <div className="flex items-start gap-3">
                <Checkbox aria-label={`Select ${itemName(i)}`} checked={selected.has(i.id)} onCheckedChange={(on) => toggle(i.id, on === true)} className="mt-1" />
                <div className="min-w-0">
                  <p className="font-medium">{itemName(i)}</p>
                  <p className="truncate text-xs text-muted-foreground" title={i.url}>
                    {i.url.replace(/^https:\/\/www\.linkedin\.com/, "")}
                  </p>
                </div>
              </div>
              <div>
                <RowStatus item={i} capacityReturns={capacityReturns} />
              </div>
              <p className="text-sm tabular-nums text-muted-foreground">
                Found {i.found.toLocaleString("en-US")} / {i.maxResults.toLocaleString("en-US")}. In leads <InLeads item={i} />.
              </p>
              <RowActions item={i} canRemove={canManage} onAction={onRowAction} />
            </li>
          ))}
        </ul>
      </div>

      <Dialog open={adding} onOpenChange={(open) => !open && closeAdd()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add searches to this batch</DialogTitle>
            <DialogDescription>Paste one LinkedIn or Sales Navigator people search URL per line. They use this batch&apos;s result limit and campaign.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="batch-add-urls">Search URLs</Label>
            <Textarea id="batch-add-urls" rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://www.linkedin.com/search/results/people/?keywords=cto" autoFocus />
          </div>
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeAdd} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={addSearches} disabled={busy || pasted.trim() === ""}>
              {busy ? "Queuing searches…" : "Queue searches"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={runAsk !== null}
        onOpenChange={(open) => !open && setRunAsk(null)}
        title={runConfirmation.title}
        description={runConfirmation.description}
        confirmLabel={runAsk?.ids ? "Run selected" : "Run now"}
        pendingLabel="Starting…"
        onConfirm={confirmRun}
      />

      <ConfirmDialog
        open={danger !== null}
        onOpenChange={(open) => !open && setDanger(null)}
        title={dangerTitle(danger, batch.name)}
        description={dangerDescription(danger, batch.queries)}
        confirmLabel={danger?.kind === "batch" ? "Delete batch" : danger?.kind === "remove" ? "Remove searches" : danger?.kind === "cancel" ? "Stop search" : "Delete results"}
        pendingLabel={danger?.kind === "batch" ? "Deleting batch…" : danger?.kind === "remove" ? "Removing searches…" : danger?.kind === "cancel" ? "Stopping search…" : "Deleting results…"}
        destructive
        onConfirm={confirmDanger}
      />
    </>
  );
}

/** Draws a bar instead of a check while only some rows are selected. */
const INDETERMINATE =
  "data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground data-indeterminate:[&_svg]:hidden before:hidden data-indeterminate:before:block before:h-0.5 before:w-2 before:rounded-full before:bg-current before:content-['']";

function SelectAll({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: (on: boolean) => void }) {
  return <Checkbox aria-label="Select all searches" checked={checked} indeterminate={indeterminate} onCheckedChange={(on) => onChange(on === true)} className={INDETERMINATE} />;
}

/** Status word, the sentence that explains it, and the last error. Shared by the table and the mobile cards. */
function RowStatus({ item: i, capacityReturns }: { item: Item; capacityReturns: string | null }) {
  const status = i.status as SearchStatus;
  const notice = searchNotice({ status, lastError: i.lastError });
  return (
    <>
      <StatusBadge status={searchStatusLabel(status)} />
      {status === "paused_limit" && <p className="mt-1 text-xs text-muted-foreground">Waiting for the daily limit{capacityReturns ? `. Capacity returns ${capacityReturns}` : ""}.</p>}
      {i.rerunCount > 0 && <p className="mt-1 text-xs text-muted-foreground">Rerun {i.rerunCount.toLocaleString("en-US")} time{i.rerunCount === 1 ? "" : "s"}.</p>}
      {notice && (
        <p role="alert" className={cn("mt-1 text-xs", status === "failed" ? "text-destructive" : "text-muted-foreground")}>
          {notice}
        </p>
      )}
    </>
  );
}

/** The people one search added, linked to the lead list filtered by that search. */
function InLeads({ item: i }: { item: Item }) {
  if (i.imported === 0) return <>0</>;
  return (
    <Link href={`/leads?source=${encodeURIComponent(`linkedin_search:${i.id}`)}`} className="inline-block py-1 underline-offset-4 hover:underline" aria-label={`${i.imported.toLocaleString("en-US")} in Leads from ${itemName(i)}, open the list`}>
      {i.imported.toLocaleString("en-US")}
    </Link>
  );
}

/** One or two buttons for the row's status and a menu for the rest. The status-to-actions rule lives in the domain. */
function RowActions({ item, canRemove, onAction, className }: { item: Item; canRemove: boolean; onAction: (item: Item, action: BatchRowActionId) => void; className?: string }) {
  const { buttons, menu } = batchRowActions(item.status as SearchStatus, { canRemove });
  if (buttons.length === 0 && menu.length === 0) return null;
  const firstDestructive = menu.findIndex((a) => a.id === "cancel" || a.id === "remove");
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {buttons.map((a) => (
        <Button key={a.id} size="sm" variant="outline" className={TOUCH} aria-label={`${a.label} ${itemName(item)}`} onClick={() => onAction(item, a.id)}>
          {a.label}
        </Button>
      ))}
      {menu.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="sm" variant="ghost" className={TOUCH} aria-label={`More actions for ${itemName(item)}`} />}>
            More
            <ChevronDownIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-40">
            {menu.map((a, index) => (
              <Fragment key={a.id}>
                {index === firstDestructive && index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem variant={a.id === "cancel" || a.id === "remove" ? "destructive" : "default"} onClick={() => onAction(item, a.id)}>
                  {a.label}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

const searches = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "search" : "searches"}`;

function dangerTitle(danger: Danger | null, batchName: string): string {
  if (!danger) return "";
  if (danger.kind === "remove") return `Remove ${searches(danger.ids.length)}?`;
  if (danger.kind === "results") return danger.ids ? `Delete the stored results of ${searches(danger.ids.length)}?` : `Delete the stored results of "${batchName}"?`;
  if (danger.kind === "cancel") return `Stop the search "${danger.name}"?`;
  return `Delete the batch "${batchName}"?`;
}

function dangerDescription(danger: Danger | null, queries: number): string {
  if (!danger) return "";
  if (danger.kind === "remove") return `The searches leave this batch, and the results stored for them are deleted. ${KEEP_NOTE}`;
  if (danger.kind === "results") return `The stored results of each search are deleted. The searches stay in the batch. ${KEEP_NOTE}`;
  if (danger.kind === "cancel") return "The search stops for good and cannot be resumed. People it already found stay in Leads.";
  return `The batch, its ${queries.toLocaleString("en-US")} ${queries === 1 ? "search" : "searches"} and their stored results are deleted. ${KEEP_NOTE} This cannot be undone.`;
}
