"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { EmptyState } from "@/components/shell/empty-state";
import { ListPager } from "@/components/shell/list-pager";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollableTable } from "@/components/ui/scrollable-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { toastResult, useApiAction } from "@/app/_lib/use-api-action";
import { countOf, formatCount } from "@/shared/format-number";

interface Row {
  id: string;
  source: "gmail" | "linkedin";
  accountRef: string | null;
  eventType: string;
  state: "dead" | "retrying" | "queued" | "dismissed";
  attempts: number;
  error: string | null;
  subject: string | null;
  from: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
  dismissedAt: string | null;
  dismissedBy: string | null;
}

const STATE_ITEMS = [
  { value: "open", label: "Needs attention" },
  { value: "dead", label: "Gave up" },
  { value: "queued", label: "Retry queued" },
  { value: "retrying", label: "Retrying automatically" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];
const SOURCE_ITEMS = [
  { value: "all", label: "All sources" },
  { value: "gmail", label: "Gmail" },
  { value: "linkedin", label: "LinkedIn" },
];
const STATE_LABEL: Record<Row["state"], string> = { dead: "Gave up", queued: "Retry queued", retrying: "Retrying", dismissed: "Dismissed" };

interface Props {
  rows: Row[];
  total: number;
  page: number;
  pageSize: number;
  state: string;
  source: string;
  /** LinkedIn deliveries that gave up, wait for an automatic retry, or are queued. Replay puts them all back in line. Null hides Replay. */
  linkedinBacklog: { dead: number; retrying: number; queued: number } | null;
}

export function InboundEventsPanel({ rows, total, page, pageSize, state, source, linkedinBacklog }: Props) {
  const router = useRouter();
  const { busy, run } = useApiAction();
  const refresh = () => router.refresh();
  const pageCount = Math.max(Math.ceil(total / pageSize), 1);

  const href = (next: { state?: string; source?: string; page?: number }) => {
    const params = new URLSearchParams();
    const s = next.state ?? state;
    const src = next.source ?? source;
    if (s !== "open") params.set("state", s);
    if (src !== "all") params.set("source", src);
    if ((next.page ?? 1) > 1) params.set("page", String(next.page));
    const query = params.toString();
    return `/settings/inbound-events${query ? `?${query}` : ""}`;
  };

  const waiting = linkedinBacklog ? linkedinBacklog.dead + linkedinBacklog.retrying + linkedinBacklog.queued : 0;

  const replay = () =>
    run("replay", async () => {
      const result = await runApiAction(callApi<{ requeued: number; claimed: number; done: number; failed: number }>("/api/linkedin/jobs/replay-webhooks", "POST"));
      // A replay that stops partway has still applied some deliveries, so the page reloads either way.
      refresh();
      if (!result.ok) toast.error(result.error);
      else toast.success(`Replayed ${countOf(result.data.claimed, "delivery", "deliveries")}: ${formatCount(result.data.done)} applied, ${formatCount(result.data.failed)} failed again.`);
    });

  const settle = (row: Row, action: "retry" | "dismiss") =>
    run(`${action}:${row.id}`, async () => toastResult(await runApiAction(callApi(`/api/inbound-events/${row.id}/${action}`, "POST"), { refresh }), action === "retry" ? "Queued for retry." : "Dismissed."));

  return (
    <div className="stack-group">
      <div className="flex flex-wrap items-center gap-2">
        <Select items={STATE_ITEMS} value={state} onValueChange={(v) => v && router.push(href({ state: v }))}>
          <SelectTrigger aria-label="State" className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATE_ITEMS.map((i) => (
              <SelectItem key={i.value} value={i.value}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select items={SOURCE_ITEMS} value={source} onValueChange={(v) => v && router.push(href({ source: v }))}>
          <SelectTrigger aria-label="Source" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCE_ITEMS.map((i) => (
              <SelectItem key={i.value} value={i.value}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {linkedinBacklog && (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <span className="text-sm text-muted-foreground tabular-nums">
              {waiting === 0 ? "No LinkedIn delivery waits." : `LinkedIn: ${formatCount(linkedinBacklog.dead)} gave up, ${formatCount(linkedinBacklog.retrying)} retrying, ${formatCount(linkedinBacklog.queued)} queued`}
            </span>
            <Button variant="outline" size="sm" onClick={() => void replay()} disabled={busy !== null || waiting === 0}>
              {busy === "replay" ? "Replaying…" : "Replay LinkedIn deliveries"}
            </Button>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Nothing to review" description="No inbound events match these filters." />
      ) : (
        <ScrollableTable>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Error</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.source === "gmail" ? "Gmail" : "LinkedIn"}</TableCell>
                  {/* Long values wrap rather than truncate, so the whole text reads on touch and keyboard too. */}
                  <TableCell className="max-w-48 whitespace-normal break-all">
                    {row.accountRef ?? "Unknown"}
                  </TableCell>
                  <TableCell className="max-w-56">
                    <div className="break-words whitespace-normal">{row.eventType}</div>
                    {(row.from || row.subject) && (
                      <div className="text-xs break-words whitespace-normal text-muted-foreground">
                        {[row.from, row.subject].filter(Boolean).join(": ")}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.state === "dead" ? "destructive" : "secondary"}>{STATE_LABEL[row.state]}</Badge>
                    {row.state === "dismissed" && row.dismissedAt && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {row.dismissedBy ? `${row.dismissedBy}, ` : ""}
                        <Time value={row.dismissedAt} />
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(row.attempts)}</TableCell>
                  <TableCell className="whitespace-nowrap"><Time value={row.createdAt} /></TableCell>
                  <TableCell className="max-w-72 whitespace-normal break-words text-xs text-muted-foreground">{row.error ?? "No error recorded."}</TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {(row.state === "dead" || row.state === "dismissed") && (
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void settle(row, "retry")}>
                        {busy === `retry:${row.id}` ? "Retrying…" : "Retry"}
                      </Button>
                    )}{" "}
                    {row.state !== "dismissed" && (
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void settle(row, "dismiss")}>
                        {busy === `dismiss:${row.id}` ? "Dismissing…" : "Dismiss"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollableTable>
      )}

      <ListPager total={total} page={page} pageCount={pageCount} noun={["event", "events"]} hrefFor={(p) => href({ page: p })} />
    </div>
  );
}
