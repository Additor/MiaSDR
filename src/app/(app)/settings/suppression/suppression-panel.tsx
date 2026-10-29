"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { EmptyState } from "@/components/shell/empty-state";
import { ListPager } from "@/components/shell/list-pager";
import { SearchField } from "@/components/shell/search-field";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/app/_lib/api-client";
import { cn } from "@/components/ui/utils";
import { AdminNotice } from "../admin-notice";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";
import { countOf, formatCount } from "@/shared/format-number";

interface Row {
  id: string;
  email: string;
  reason: "unsubscribed" | "bounced" | "manual" | "complaint";
  note: string | null;
  addedInSettings: boolean;
  createdAt: string;
}

const REASON_LABEL: Record<Row["reason"], string> = { unsubscribed: "Unsubscribed", bounced: "Bounced", manual: "Stopped by a person", complaint: "Spam complaint" };
/** A `manual` row pasted here reads apart from one a stop request or a do-not-contact deletion wrote, which cannot be removed. */
const reasonLabel = (row: Row) => (row.addedInSettings ? "Added here" : REASON_LABEL[row.reason]);

export function SuppressionPanel({ rows, total, page, pageSize, q, canManage }: { rows: Row[]; total: number; page: number; pageSize: number; q: string; canManage: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<Row | null>(null);
  const pageCount = Math.max(Math.ceil(total / pageSize), 1);
  const href = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (p > 1) params.set("page", String(p));
    const query = params.toString();
    return `/settings/suppression${query ? `?${query}` : ""}`;
  };

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError(null);
    const result = await callApi<{ added: number; alreadyListed: number; stopped: number }>("/api/suppressions", "POST", { text: String(data.get("emails") ?? ""), note: String(data.get("note") ?? "") || null });
    setPending(false);
    if (!result.ok || !result.data) {
      setError(result.error);
      return;
    }
    form.reset();
    const { added, alreadyListed, stopped } = result.data;
    toast.success(
      [`${countOf(added, "address", "addresses")} added.`, alreadyListed > 0 ? `${formatCount(alreadyListed)} already on the list.` : null, stopped > 0 ? `${countOf(stopped, "sequence")} stopped.` : null].filter(Boolean).join(" "),
    );
    router.refresh();
  }

  async function remove(row: Row) {
    const result = await callApi(`/api/suppressions/${row.id}`, "DELETE");
    if (!result.ok) throw new Error(result.error ?? "Could not remove the address.");
    toast.success(`${row.email} removed.`);
    router.refresh();
  }

  return (
    <div>
      <div className="stack-group pb-section">
        <p className="text-sm text-muted-foreground">
          Campaigns and replies never email an address on this list. An unsubscribe link, a verified bounce and Suppress in the Inbox add to it. LinkedIn stays open: use Do not contact on a person to stop every channel.
        </p>
        {!canManage && <AdminNotice action="add or remove addresses" />}
      </div>

      {canManage && (
        <SettingsSection title="Add addresses" description="Paste up to 500 addresses, separated by commas, spaces or line breaks. Each one stops its unfinished email sequences.">
          <form onSubmit={add}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="suppress-emails">Email addresses</FieldLabel>
                <Textarea id="suppress-emails" name="emails" rows={4} required placeholder={"ada@acme.com\nbo@globex.com"} className="font-mono text-sm" />
              </Field>
              <Field>
                <FieldLabel htmlFor="suppress-note">Note (optional)</FieldLabel>
                <Input id="suppress-note" name="note" maxLength={500} placeholder="Asked by phone not to be emailed" />
              </Field>
              {error && <FieldError>{error}</FieldError>}
              <div>
                <Button type="submit" disabled={pending}>
                  {pending ? "Adding…" : "Add to the list"}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </SettingsSection>
      )}

      <SettingsSection title="Suppressed addresses">
        <form action="/settings/suppression" className="flex flex-wrap items-center gap-2">
          <SearchField label="Search addresses" defaultValue={q} placeholder="Search addresses" maxLength={320} />
        </form>
        {rows.length === 0 ? (
          <EmptyState
            className="py-0"
            title={q ? "No address matches" : "No suppressed addresses"}
            description={q ? "Try part of the address or the domain." : "Unsubscribes, bounces and addresses you add show here."}
            action={q ? { label: "Clear search", href: "/settings/suppression" } : undefined}
          />
        ) : (
          <ul className={RULED_LIST} aria-label="Suppressed addresses">
            {rows.map((row) => (
              <li key={row.id} className={cn(RULED_ROW, "flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1")}>
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate text-sm font-medium">{row.email}</span>
                  <span className="text-xs text-muted-foreground">
                    <Time value={row.createdAt} dateOnly />
                    {row.note ? `, ${row.note}` : ""}
                  </span>
                </div>
                <Badge variant="secondary">{reasonLabel(row)}</Badge>
                {canManage && row.addedInSettings && (
                  <Button variant="ghost" size="sm" onClick={() => setRemoving(row)} aria-label={`Remove ${row.email}`}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <ListPager total={total} page={page} pageCount={pageCount} noun={["address", "addresses"]} hrefFor={href} />
      </SettingsSection>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.email ?? "this address"}?`}
        description="Campaigns can email this address again. Sequences that stopped stay stopped; enroll the lead again to restart."
        confirmLabel="Remove address"
        cancelLabel="Keep suppressed"
        pendingLabel="Removing…"
        destructive
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </div>
  );
}
