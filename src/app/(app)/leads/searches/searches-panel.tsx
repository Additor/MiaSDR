"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { StatusBadge } from "@/components/shell/status-badge";
import { useOrgTimeZone } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeSearch, isActiveStatus, searchActions, searchNotice, searchStatusLabel, type SearchAction, type SearchStatus } from "@/contexts/outreach/linkedin/domain/linkedin-search";
import { callApi } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { capacityReturnText } from "./capacity-return";
import { SearchCapacityCard, type CapacityCardData } from "./search-capacity-card";
import { UploadSheet, type UploadSheetConfig } from "./upload-sheet";
import { useActiveRefresh } from "./use-active-refresh";

interface Search {
  id: string;
  name: string;
  url: string;
  variant: "classic" | "sales_navigator";
  status: SearchStatus;
  maxResults: number;
  found: number;
  imported: number;
  totalEstimate: number | null;
  pagesFetched: number;
  lastError: string | null;
  targetCampaign: { id: string; name: string } | null;
  account: string | null;
}

interface State {
  searches: Search[];
  batches: Array<{ id: string; name: string; searches: number }>;
  connectedAccounts: number;
  defaultMaxResults: number;
  maxResultsLimit: number;
}

const NO_CAMPAIGN = "none";

export function SearchesPanel({ state, capacity, campaigns, upload }: { state: State; capacity: CapacityCardData; campaigns: Array<{ id: string; name: string }>; upload: UploadSheetConfig }) {
  const router = useRouter();
  const timeZone = useOrgTimeZone();
  const [cancelling, setCancelling] = useState<Search | null>(null);
  const capacityReturns = capacityReturnText(capacity.nextReturnAt, timeZone);

  // Pages arrive in the background, so the list refreshes itself while a search works.
  useActiveRefresh(state.searches.some((s) => isActiveStatus(s.status)));

  async function act(search: Search, action: SearchAction) {
    if (action === "cancel") {
      setCancelling(search);
      return;
    }
    const result = await callApi(`/api/linkedin/searches/${search.id}/action`, "POST", { action });
    if (!result.ok) toast.error(result.error ?? "Could not change the search. Try again.");
    router.refresh();
  }

  async function cancelSearch() {
    if (!cancelling) return;
    const result = await callApi(`/api/linkedin/searches/${cancelling.id}/action`, "POST", { action: "cancel" });
    // ConfirmDialog shows the thrown message and keeps the dialog open.
    if (!result.ok) throw new Error(result.error ?? "Could not cancel the search. Try again.");
    router.refresh();
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex flex-wrap gap-2">
          <UploadSheet config={upload} campaigns={campaigns} variant="outline" />
          <NewSearch campaigns={campaigns} defaultMax={state.defaultMaxResults} maxLimit={state.maxResultsLimit} />
        </div>
      </div>

      {state.connectedAccounts === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No LinkedIn account connected</CardTitle>
            <CardDescription>
              Searches wait until an account is connected. <Link href="/settings/linkedin" className="underline underline-offset-4">Connect a LinkedIn account</Link>.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <SearchCapacityCard capacity={capacity} />

      {state.batches.length > 0 && (
        <ul className="grid gap-1 text-sm" aria-label="Sheet batches">
          {state.batches.map((batch) => (
            <li key={batch.id}>
              <Link href={`/leads/searches/batches/${batch.id}`} className="inline-block py-1 underline-offset-4 hover:underline max-sm:py-3">
                {batch.searches.toLocaleString("en-US")} {batch.searches === 1 ? "search" : "searches"} in batch {batch.name}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {state.searches.length === 0 ? (
        <EmptyState title="No searches yet" description="Paste the URL of a LinkedIn or Sales Navigator people search. MiaSDR reads it page by page within each account's daily limit and adds the people to Leads." />
      ) : (
        <ScrollableTable>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Search</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Found</TableHead>
              <TableHead className="text-right">In leads</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.searches.map((s) => {
              const progress = describeSearch({ status: s.status, found: s.found, maxResults: s.maxResults, pagesFetched: s.pagesFetched, capacityReturns });
              const notice = searchNotice(s);
              return (
                <TableRow key={s.id}>
                  <TableCell className="max-w-72">
                    <p className="font-medium">{s.name}</p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge variant="outline">{s.variant === "sales_navigator" ? "Sales Navigator" : "LinkedIn"}</Badge>
                      <span className="truncate" title={s.url}>
                        {s.url.replace(/^https:\/\/www\.linkedin\.com/, "")}
                      </span>
                    </p>
                    <SearchActions search={s} onAct={act} className="mt-2 sm:hidden" />
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal">
                    <StatusBadge status={searchStatusLabel(s.status)} />
                    <p className="mt-1 text-xs text-muted-foreground">{progress.detail}</p>
                    {notice && (
                      <p role="alert" className={cn("mt-1 text-xs", s.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                        {notice}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.found.toLocaleString("en-US")} / {s.maxResults.toLocaleString("en-US")}
                    {s.totalEstimate !== null && <p className="text-xs text-muted-foreground">About {s.totalEstimate.toLocaleString("en-US")} matches</p>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.imported > 0 ? (
                      <Link href={`/leads?source=${encodeURIComponent(`linkedin_search:${s.id}`)}`} className="underline-offset-4 hover:underline" aria-label={`${s.imported.toLocaleString("en-US")} in Leads from ${s.name}, open the list`}>
                        {s.imported.toLocaleString("en-US")}
                      </Link>
                    ) : (
                      s.imported.toLocaleString("en-US")
                    )}
                    {s.found > s.imported && <p className="text-xs text-muted-foreground">{(s.found - s.imported).toLocaleString("en-US")} without a public profile</p>}
                  </TableCell>
                  <TableCell>
                    {s.targetCampaign ? (
                      <Link href={`/campaigns/${s.targetCampaign.id}`} className="underline-offset-4 hover:underline">
                        {s.targetCampaign.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Leads only</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-right sm:table-cell">
                    <SearchActions search={s} onAct={act} className="justify-end" />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        </ScrollableTable>
      )}

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        title={`Stop the search "${cancelling?.name ?? ""}"?`}
        description="The search stops for good and cannot be resumed. People it already found stay in Leads. To search again, create a new search."
        confirmLabel="Stop search"
        pendingLabel="Stopping…"
        destructive
        onConfirm={cancelSearch}
      />
    </>
  );
}

/** Pause, resume and cancel. Below the sm breakpoint they sit under the search name, because the Actions column scrolls out of sight. */
function SearchActions({ search: s, onAct, className }: { search: Search; onAct: (search: Search, action: SearchAction) => void; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {searchActions(s.status).map(({ action, label }) => (
        <Button key={action} size="sm" variant={action === "cancel" ? "ghost" : "outline"} className="max-sm:h-11 max-sm:px-4" onClick={() => onAct(s, action)}>
          {label}
        </Button>
      ))}
    </div>
  );
}

function NewSearch({ campaigns, defaultMax, maxLimit }: { campaigns: Array<{ id: string; name: string }>; defaultMax: number; maxLimit: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [campaign, setCampaign] = useState(NO_CAMPAIGN);
  const items = [{ value: NO_CAMPAIGN, label: "No campaign (leads only)" }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))];

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const result = await callApi<{ id: string }>("/api/linkedin/searches", "POST", {
      name: String(form.get("name")),
      url: String(form.get("url")),
      maxResults: Number(form.get("maxResults")),
      campaignId: campaign === NO_CAMPAIGN ? null : campaign,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    setCampaign(NO_CAMPAIGN);
    toast.success("Search queued.");
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="max-sm:h-11 max-sm:px-4" />}>New search</DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New LinkedIn search</DialogTitle>
            <DialogDescription>Search for people on LinkedIn or Sales Navigator, then copy the URL from your browser address bar.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="search-name">Name</Label>
            <Input id="search-name" name="name" placeholder="CTOs at Berlin fintechs" required maxLength={120} autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="search-url">Search URL</Label>
            <Input id="search-url" name="url" type="url" placeholder="https://www.linkedin.com/search/results/people/?keywords=cto" required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="search-max">Stop after</Label>
            <Input id="search-max" name="maxResults" type="number" min={1} max={maxLimit} defaultValue={defaultMax} required />
            <p className="text-xs text-muted-foreground">People, up to {maxLimit.toLocaleString("en-US")}. Each account reads a limited number per day, so large searches take days.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="search-campaign">Add to campaign</Label>
            <Select items={items} value={campaign} onValueChange={(v) => v && setCampaign(v)}>
              <SelectTrigger id="search-campaign" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create search"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
