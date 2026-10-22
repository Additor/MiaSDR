"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/shell/empty-state";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";
import { channelLabel } from "@/contexts/outreach/domain/campaign-view";

interface Row {
  id: string;
  channel: string;
  accountRef: string;
  identityValue: string | null;
  reason: string;
  createdAt: string;
  sender: string | null;
  subject: string | null;
  excerpt: string;
  /** Present for a reviewed row. A resolved row whose person was deleted keeps a null person (migration 0027). */
  status?: string;
  resolvedPersonId?: string | null;
}

/** The line that replaces the person picker on a resolved row whose person was deleted, else null. */
export function resolutionLine(row: Pick<Row, "status" | "resolvedPersonId">): string | null {
  return row.status === "resolved" && !row.resolvedPersonId ? "Resolved to a deleted contact" : null;
}

/** A row of `GET /api/people/search`: any person of the organization, lead or contact. */
interface Candidate {
  personId: string;
  name: string | null;
  email: string | null;
  company: string | null;
  lifecycle: string;
}

export function ExceptionsPanel({ rows }: { rows: Row[] }) {
  if (rows.length === 0) {
    return <EmptyState className="max-w-3xl" title="No unmatched senders" description="Every inbound message matched a person." />;
  }
  // One ruled list: a hairline and section space between messages, no card per message.
  return (
    <ul className="max-w-3xl divide-y" aria-label="Unmatched messages">
      {rows.map((row) => (
        <ExceptionRow key={row.id} row={row} />
      ))}
    </ul>
  );
}

function ExceptionRow({ row }: { row: Row }) {
  const resolution = resolutionLine(row);
  return (
    <li data-testid="unmatched-message" className="stack-group py-section text-sm first:pt-0 last:pb-0">
      <div className="stack-field">
        <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {row.sender ?? "Unknown sender"}
          <Badge variant="outline">{channelLabel(row.channel)}</Badge>
        </h2>
        <p className="text-muted-foreground">
          {row.reason.replace(/\.$/, "")}. Received on {row.accountRef}, <Time value={row.createdAt} />.
        </p>
      </div>
      {row.subject && <div className="font-medium">{row.subject}</div>}
      <p className="whitespace-pre-wrap text-muted-foreground">{row.excerpt}</p>
      {resolution ? <p className="text-muted-foreground">{resolution}</p> : <PersonPicker row={row} />}
    </li>
  );
}

function PersonPicker({ row }: { row: Row }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const result = await callApi<{ rows: Candidate[] }>(`/api/people/search?q=${encodeURIComponent(query.trim())}`, "GET");
    if (!result.ok || !result.data) return setError(result.error);
    setCandidates(result.data.rows);
  }

  async function submit(body: { status: "resolved"; personId: string } | { status: "ignored" }) {
    setPending(true);
    setError(null);
    const result = await callApi(`/api/identity-exceptions/${row.id}`, "PATCH", body);
    setPending(false);
    if (!result.ok) return setError(result.error);
    toast.success(body.status === "resolved" ? `Message filed under ${chosen ? (chosen.name ?? chosen.email ?? "the person") : "the person"}.` : "Message ignored.");
    router.refresh();
  }

  return (
    <>
      <form onSubmit={search} className="flex flex-wrap items-end gap-2">
        <div className="stack-field">
          <Label htmlFor={`find-${row.id}`}>File it under</Label>
          <Input id={`find-${row.id}`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people by name, email or company" className="w-80 max-w-full" />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={query.trim() === ""}>
          Search
        </Button>
      </form>
      {candidates && candidates.length === 0 && <p className="text-muted-foreground">Nobody matches &ldquo;{query.trim()}&rdquo;. Try an email address or a company.</p>}
      {candidates && candidates.length > 0 && (
        <ul className="grid gap-1" aria-label="Matching people">
          {candidates.slice(0, 8).map((c) => (
            <li key={c.personId}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border p-2 has-[:checked]:border-ring has-[:checked]:bg-muted/50">
                <input type="radio" name={`person-${row.id}`} checked={chosen?.personId === c.personId} onChange={() => setChosen(c)} />
                <span className="min-w-0 flex-1 truncate">
                  {c.name ?? c.email}
                  <span className="text-muted-foreground">{[c.name ? c.email : null, c.company].filter(Boolean).length ? `, ${[c.name ? c.email : null, c.company].filter(Boolean).join(", ")}` : ""}</span>
                </span>
                {c.lifecycle === "contact" && <Badge variant="outline">Contact</Badge>}
              </label>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending || !chosen} onClick={() => chosen && submit({ status: "resolved", personId: chosen.personId })}>
          File under {chosen ? (chosen.name ?? chosen.email) : "the chosen person"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => submit({ status: "ignored" })}>
          Ignore
        </Button>
      </div>
    </>
  );
}
