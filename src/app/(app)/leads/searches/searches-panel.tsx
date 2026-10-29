"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { StatusBadge } from "@/components/shell/status-badge";
import { useOrgTimeZone } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeSearch, isActiveStatus, searchActions, searchNotice, searchStatusLabel, type SearchAction, type SearchStatus } from "@/contexts/outreach/linkedin/domain/linkedin-search";
import { callApi } from "@/app/_lib/api-client";
import { countOf, formatCount } from "@/shared/format-number";
import { cn } from "@/components/ui/utils";
import { capacityReturnText } from "./capacity-return";
import { SearchUrl } from "./search-url";
import { SearchCapacityCard, type CapacityCardData } from "./search-capacity-card";
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
}

const NO_CAMPAIGN = "none";

export function SearchesPanel({ state, capacity }: { state: State; capacity: CapacityCardData }) {
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
      {state.connectedAccounts === 0 && (
        <p className="text-sm">
          No LinkedIn account connected. Searches wait until an account is connected.{" "}
          <Link href="/settings/linkedin" className="underline underline-offset-4">
            Connect a LinkedIn account
          </Link>
          .
        </p>
      )}

      <SearchCapacityCard capacity={capacity} />

      {state.batches.length > 0 && (
        <ul className="grid gap-1 text-sm" aria-label="Sheet batches">
          {state.batches.map((batch) => (
            <li key={batch.id}>
              <Link href={`/leads/searches/batches/${batch.id}`} className="inline-block rounded-sm py-1 underline-offset-4 hover:underline focus-ring max-sm:py-3">
                {countOf(batch.searches, "search", "searches")} in batch {batch.name}
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
                      <SearchUrl url={s.url} />
                    </p>
                    <SearchActions search={s} onAct={act} className="mt-2 sm:hidden" />
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-normal">
                    <StatusBadge status={s.status} label={searchStatusLabel(s.status)} />
                    <p className="mt-1 text-xs text-muted-foreground">{progress.detail}</p>
                    {notice && (
                      <p role="alert" className={cn("mt-1 text-xs", s.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                        {notice}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(s.found)} / {formatCount(s.maxResults)}
                    {s.totalEstimate !== null && <p className="text-xs text-muted-foreground">About {formatCount(s.totalEstimate)} matches</p>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.imported > 0 ? (
                      <Link href={`/leads?source=${encodeURIComponent(`linkedin_search:${s.id}`)}`} className="rounded-sm underline-offset-4 hover:underline focus-ring" aria-label={`${formatCount(s.imported)} in Leads from ${s.name}, open the list`}>
                        {formatCount(s.imported)}
                      </Link>
                    ) : (
                      formatCount(s.imported)
                    )}
                    {s.found > s.imported && <p className="text-xs text-muted-foreground">{formatCount(s.found - s.imported)} without a public profile</p>}
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
        <Button key={action} size="sm" variant={action === "cancel" ? "ghost" : "outline"} touch onClick={() => onAct(s, action)}>
          {label}
        </Button>
      ))}
    </div>
  );
}

/** New search: its button and dialog, in the page header beside Upload sheet. */
export function NewSearch({ campaigns, defaultMax, maxLimit }: { campaigns: Array<{ id: string; name: string }>; defaultMax: number; maxLimit: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [campaign, setCampaign] = useState(NO_CAMPAIGN);
  const form = useRef<HTMLFormElement>(null);
  const items = [{ value: NO_CAMPAIGN, label: "No campaign (leads only)" }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))];

  async function create(): Promise<boolean> {
    // The confirm button sits outside the form, so it asks the form to check its own fields.
    if (!form.current?.reportValidity()) return false;
    const data = new FormData(form.current);
    const result = await callApi<{ id: string }>("/api/linkedin/searches", "POST", {
      name: String(data.get("name")),
      url: String(data.get("url")),
      maxResults: Number(data.get("maxResults")),
      campaignId: campaign === NO_CAMPAIGN ? null : campaign,
    });
    // ConfirmDialog shows the thrown message and keeps the dialog open.
    if (!result.ok) throw new Error(result.error ?? "Could not create the search. Try again.");
    setCampaign(NO_CAMPAIGN);
    toast.success("Search queued.");
    router.refresh();
    return true;
  }

  return (
    <>
      <Button touch onClick={() => setOpen(true)}>
        New search
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="New LinkedIn search"
        description="Search for people on LinkedIn or Sales Navigator, then copy the URL from your browser address bar."
        confirmLabel="Create search"
        pendingLabel="Creating…"
        onConfirm={create}
      >
        <form ref={form} onSubmit={(e) => e.preventDefault()}>
          <FieldGroup>
          <Field>
            <FieldLabel htmlFor="search-name">Name</FieldLabel>
            <Input id="search-name" name="name" placeholder="CTOs at Berlin fintechs" required maxLength={120} autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor="search-url">Search URL</FieldLabel>
            <Input id="search-url" name="url" type="url" placeholder="https://www.linkedin.com/search/results/people/?keywords=cto" required />
          </Field>
          <Field>
            <FieldLabel htmlFor="search-max">Stop after</FieldLabel>
            <Input id="search-max" name="maxResults" type="number" min={1} max={maxLimit} defaultValue={defaultMax} required aria-describedby="search-max-help" />
            <FieldDescription id="search-max-help">People, up to {formatCount(maxLimit)}. Each account reads a limited number per day, so large searches take days.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="search-campaign">Add to campaign</FieldLabel>
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
          </Field>
          </FieldGroup>
        </form>
      </ConfirmDialog>
    </>
  );
}
