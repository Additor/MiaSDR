"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ChoiceCard } from "@/components/shell/choice-card";
import { EmptyState } from "@/components/shell/empty-state";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { RadioGroup } from "@/components/ui/radio-group";
import { runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { useApiAction } from "@/app/_lib/use-api-action";
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
  /** Present for a reviewed row. A resolved row whose person was deleted keeps a null person. */
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
        <h2 className="flex flex-wrap items-center gap-2 heading-item">
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
  // File and Ignore settle the same message, so each waits for the other.
  const { isBusy, anyBusy: pending, run } = useApiAction<"resolved" | "ignored">();

  async function search(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const result = await callApi<{ rows: Candidate[] }>(`/api/people/search?q=${encodeURIComponent(query.trim())}`, "GET");
    if (!result.ok || !result.data) return setError(result.error);
    setCandidates(result.data.rows);
  }

  const submit = (body: { status: "resolved"; personId: string } | { status: "ignored" }) =>
    run(body.status, async () => {
      setError(null);
      const result = await runApiAction(callApi(`/api/identity-exceptions/${row.id}`, "PATCH", body), { refresh: () => router.refresh() });
      if (!result.ok) return setError(result.error);
      toast.success(body.status === "resolved" ? `Message filed under ${chosen ? (chosen.name ?? chosen.email ?? "the person") : "the person"}.` : "Message ignored.");
    });

  return (
    <>
      <form onSubmit={search} className="flex flex-wrap items-end gap-2">
        <Field className="w-auto">
          <FieldLabel htmlFor={`find-${row.id}`}>File it under</FieldLabel>
          <Input id={`find-${row.id}`} touch value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people by name, email or company" className="w-80 max-w-full" />
        </Field>
        <Button type="submit" size="sm" variant="outline" touch disabled={query.trim() === ""}>
          Search
        </Button>
      </form>
      {candidates && candidates.length === 0 && <p className="text-muted-foreground">Nobody matches &ldquo;{query.trim()}&rdquo;. Try an email address or a company.</p>}
      {candidates && candidates.length > 0 && (
        <RadioGroup
          aria-label="Matching people"
          className="gap-1"
          value={chosen?.personId ?? null}
          onValueChange={(personId) => setChosen(candidates.find((c) => c.personId === personId) ?? null)}
        >
          {candidates.slice(0, 8).map((c) => (
            <ChoiceCard key={c.personId} id={`person-${row.id}-${c.personId}`} value={c.personId} trailing={c.lifecycle === "contact" ? <Badge variant="outline">Contact</Badge> : undefined}>
              {c.name ?? c.email}
              <span className="text-muted-foreground">{[c.name ? c.email : null, c.company].filter(Boolean).length ? `, ${[c.name ? c.email : null, c.company].filter(Boolean).join(", ")}` : ""}</span>
            </ChoiceCard>
          ))}
        </RadioGroup>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" touch disabled={pending || !chosen} onClick={() => chosen && void submit({ status: "resolved", personId: chosen.personId })}>
          {isBusy("resolved") ? "Filing…" : `File under ${chosen ? (chosen.name ?? chosen.email) : "the chosen person"}`}
        </Button>
        <Button size="sm" variant="ghost" touch disabled={pending} onClick={() => void submit({ status: "ignored" })}>
          {isBusy("ignored") ? "Ignoring…" : "Ignore"}
        </Button>
      </div>
    </>
  );
}
