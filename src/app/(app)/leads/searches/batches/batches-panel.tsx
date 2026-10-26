"use client";

import Link from "next/link";
import { EmptyState } from "@/components/shell/empty-state";
import { Time } from "@/components/shell/time";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { hasActiveSearch, searchStatusLabel, type SearchStatus } from "@/contexts/outreach/linkedin/domain/linkedin-search";
import { useActiveRefresh } from "../use-active-refresh";

interface Batch {
  id: string;
  name: string;
  createdAt: string;
  queries: number;
  statuses: Record<string, number>;
  found: number;
  imported: number;
  campaign: { id: string; name: string } | null;
}

interface State {
  batches: Batch[];
  maxRows: number;
}

export function statusSummary(statuses: Record<string, number>): string {
  const order = ["running", "queued", "paused", "paused_limit", "failed", "completed", "cancelled"];
  return order
    .filter((s) => statuses[s])
    .map((s) => `${statuses[s].toLocaleString("en-US")} ${searchStatusLabel(s as SearchStatus)}`)
    .join(", ");
}

export function BatchesPanel({ state }: { state: State }) {
  // Batches show "1 running" while pages arrive, so the list refreshes itself until nothing is active.
  useActiveRefresh(state.batches.some((b) => hasActiveSearch(b.statuses)));
  return (
    <>
      {state.batches.length === 0 ? (
        <EmptyState
          title="No batches yet"
          description={`Upload a CSV or XLSX file with one LinkedIn or Sales Navigator people search URL per row (up to ${state.maxRows.toLocaleString("en-US")}). The upload dialog has a template. MiaSDR reads the searches in order within each account's daily limit.`}
        />
      ) : (
        <ScrollableTable>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Batch</TableHead>
              <TableHead>Searches</TableHead>
              <TableHead className="text-right">Found</TableHead>
              <TableHead className="text-right">In leads</TableHead>
              <TableHead>Campaign</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.batches.map((b) => (
              <TableRow key={b.id}>
                <TableCell>
                  <Link href={`/leads/searches/batches/${b.id}`} className="inline-block py-1 font-medium underline-offset-4 hover:underline max-sm:py-3">
                    {b.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    <Time value={b.createdAt} dateOnly />
                  </p>
                </TableCell>
                <TableCell className="whitespace-normal">
                  {b.queries.toLocaleString("en-US")}
                  <p className="text-xs text-muted-foreground">{statusSummary(b.statuses)}</p>
                </TableCell>
                <TableCell className="text-right tabular-nums">{b.found.toLocaleString("en-US")}</TableCell>
                <TableCell className="text-right tabular-nums">{b.imported.toLocaleString("en-US")}</TableCell>
                <TableCell>{b.campaign ? b.campaign.name : <span className="text-muted-foreground">Leads only</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </ScrollableTable>
      )}
    </>
  );
}
