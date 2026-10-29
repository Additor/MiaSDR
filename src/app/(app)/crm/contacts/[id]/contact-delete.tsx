"use client";

import { EllipsisIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { useOrgTimeZone } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/shared/format-time";
import { runApiAction } from "@/app/_lib/api-action";
import { apiMessage, callApi } from "@/app/_lib/api-client";
import { dealHref } from "../../_components/deal-href";
import { contactLabel } from "../../_components/labels";
import { openDncControl } from "@/app/(app)/_components/person/dnc-control";
import {
  CANNOT_DELETE,
  COUNTS_INTRO,
  blockerText,
  countLines,
  countsChangedText,
  deleteDescription,
  deletedText,
  expectedQuery,
  goneText,
  reachLines,
  type DeleteBlocker,
  type DeleteCounts,
  type DeletePreview,
} from "./contact-delete-copy";

/**
 * The contact's rare actions: a ghost More menu in the header with Delete contact, as company and deal pages keep theirs.
 * The dialog reads the delete preview when it opens: each blocker with the open deals linked, or the counts the delete
 * takes with it.
 */
export function ContactMoreMenu({ preview, returnTo }: { preview: DeletePreview; returnTo: string }) {
  const [open, setOpen] = useState(false);
  const name = contactLabel(preview.person);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" aria-label={`More actions for ${name}`} />}>
          <EllipsisIcon aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-48">
          <DropdownMenuItem variant="destructive" className="max-sm:min-h-11" onClick={() => setOpen(true)}>
            Delete contact
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteContactDialog personId={preview.person.id} initialName={name} returnTo={returnTo} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Each blocker's sentence; the open deals follow as links to their pages, which come back here after a delete. */
function BlockerList({ blockers, name, personId }: { blockers: DeleteBlocker[]; name: string; personId: string }) {
  const timeZone = useOrgTimeZone();
  const time = (iso: string) => formatDateTime(iso, timeZone);
  return (
    <ul className="grid gap-2" data-testid="contact-delete-blockers">
      {blockers.map((blocker) => (
        <li key={blocker.reason} className="grid gap-1">
          <span>{blockerText(blocker, name, time)}</span>
          {blocker.reason === "open_deals" && (
            <ul className="grid gap-1">
              {blocker.deals.map((deal) => (
                <li key={deal.id}>
                  <Link href={dealHref(deal.id, `/crm/contacts/${personId}`)} className="rounded-sm text-foreground underline underline-offset-4 hover:no-underline focus-ring max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
                    {`${deal.title}, ${deal.stageName}`}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

type Status = { kind: "blocked"; blockers: DeleteBlocker[] } | { kind: "text"; text: string } | null;

function DeleteContactDialog({
  personId,
  initialName,
  returnTo,
  open,
  onOpenChange,
}: {
  personId: string;
  initialName: string;
  returnTo: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [counts, setCounts] = useState<DeleteCounts | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [wasOpen, setWasOpen] = useState(open);

  // Each open reads the preview again.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPreview(null);
      setCounts(null);
      setStatus(null);
    }
  }

  const name = preview ? contactLabel(preview.person) : initialName;

  useEffect(() => {
    if (!open) return;
    let live = true;
    void callApi<DeletePreview>(`/api/contacts/${personId}/delete-preview`, "GET").then((result) => {
      if (!live) return;
      if (result.status === 404) {
        toast.error(goneText(initialName));
        onOpenChange(false);
        router.replace("/crm/contacts");
        return;
      }
      if (!result.ok || !result.data) return setStatus({ kind: "text", text: result.error ?? "Could not read what the delete removes. Try again." });
      const next = result.data;
      setPreview(next);
      setCounts(next.counts);
      if (next.blockers.length > 0) setStatus({ kind: "blocked", blockers: next.blockers });
    });
    return () => {
      live = false;
    };
  }, [open, personId, initialName, onOpenChange, router]);

  function done() {
    toast.success(deletedText(name));
    router.replace(returnTo);
    router.refresh();
  }

  async function remove(): Promise<boolean | void> {
    if (!counts) return false;
    // A 404 after a sent delete means the delete went through. Both leave the page, so nothing reloads it first.
    const result = await runApiAction(callApi(`/api/contacts/${personId}?${expectedQuery(counts)}`, "DELETE"), { onConflict: { try_again: () => apiMessage("try_again", name) } });
    if (result.ok || result.status === 404) return done();
    if (result.status === 0) throw new Error(result.error);
    const body = result.details;
    if (result.code === "contact_blocked" && Array.isArray(body?.blockers)) {
      setStatus({ kind: "blocked", blockers: body.blockers as DeleteBlocker[] });
      return false;
    }
    if (result.code === "counts_changed" && body?.counts) {
      setCounts(body.counts as DeleteCounts);
      setStatus({ kind: "text", text: countsChangedText(name) });
      return false;
    }
    if (typeof body?.error === "string") {
      setStatus({ kind: "text", text: result.error });
      return false;
    }
    throw new Error("Could not delete this contact. Try again.");
  }

  const reach = preview ? reachLines(preview, name) : null;
  const lines = counts ? countLines(counts) : [];
  const blocked = status?.kind === "blocked";

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${name}?`}
      description={deleteDescription(name)}
      confirmLabel="Delete contact"
      cancelLabel="Keep contact"
      pendingLabel="Deleting…"
      destructive
      confirmDisabled={!preview || !counts || blocked}
      onConfirm={remove}
    >
      {status && (
        <div role="status" className="grid gap-2 text-sm" data-testid="contact-delete-status">
          {status.kind === "blocked" ? (
            <>
              <p className="font-medium">{CANNOT_DELETE}</p>
              <BlockerList blockers={status.blockers} name={name} personId={personId} />
            </>
          ) : (
            <p>{status.text}</p>
          )}
        </div>
      )}
      {!preview ? (
        <div aria-busy="true" className="grid gap-2" data-testid="contact-delete-loading">
          <Skeleton className="h-4 w-3/4" />
          <span className="sr-only">Checking what the delete removes…</span>
        </div>
      ) : (
        !blocked && (
          <div className="grid gap-3 text-sm" data-testid="contact-delete-body">
            {lines.length > 0 && (
              <div className="stack-field">
                <p>{COUNTS_INTRO}</p>
                <ul className="grid list-disc gap-1 pl-5 tabular-nums" data-testid="contact-delete-counts">
                  {lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
            {reach && (
              <div className="grid gap-2 text-muted-foreground" data-testid="contact-delete-reach">
                {reach.suppressed && <p>{reach.suppressed}</p>}
                {reach.linkedin && <p>{reach.linkedin}</p>}
                {reach.unmarked && (
                  <p>
                    {reach.unmarked.before}
                    <button
                      type="button"
                      className="text-foreground underline underline-offset-4 hover:no-underline focus-visible:rounded-sm focus-ring"
                      onClick={() => {
                        onOpenChange(false);
                        openDncControl(personId);
                      }}
                    >
                      {reach.unmarked.action}
                    </button>
                    {reach.unmarked.after}
                  </p>
                )}
                <p>{reach.bringBack}</p>
              </div>
            )}
          </div>
        )
      )}
    </ConfirmDialog>
  );
}
