"use client";

import { Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { useOrgTimeZone } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/shared/format-time";
import { dealHref } from "../../_components/deal-href";
import { contactLabel } from "../../_components/labels";
import { openDncControl } from "../../_components/person/dnc-control";
import {
  CAN_DELETE,
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
  tryAgainText,
  type DeleteBlocker,
  type DeleteCounts,
  type DeletePreview,
} from "./contact-delete-copy";

/**
 * The delete row of a contact page, in the Do not contact panel where Delete lead sits on a lead page. The page reads
 * the delete preview on the server, so the row says before any click whether the contact can go: a button, or each blocker with
 * the open deals linked. The dialog reads the preview again and shows the counts the delete takes with it.
 */
export function ContactDeleteSection({ preview, returnTo }: { preview: DeletePreview; returnTo: string }) {
  const [open, setOpen] = useState(false);
  const name = contactLabel(preview.person);
  const blocked = preview.blockers.length > 0;

  return (
    <div className="grid gap-3" data-testid="contact-delete" data-can-delete={!blocked}>
      <div className="grid gap-1">
        <h3 className="text-sm font-medium">Delete contact</h3>
        <p className={blocked ? "font-medium" : "text-muted-foreground"} data-testid="contact-delete-state">
          {blocked ? CANNOT_DELETE : CAN_DELETE}
        </p>
        {blocked && <BlockerList blockers={preview.blockers} name={name} personId={preview.person.id} />}
      </div>
      {!blocked && (
        <>
          <div>
            <Button variant="outline" className="text-destructive hover:text-destructive max-sm:h-11" onClick={() => setOpen(true)}>
              <Trash2Icon aria-hidden />
              Delete contact
            </Button>
          </div>
          <DeleteContactDialog personId={preview.person.id} initialName={name} returnTo={returnTo} open={open} onOpenChange={setOpen} />
        </>
      )}
    </div>
  );
}

/** Each blocker's sentence; the open deals follow as links to their pages, which come back here after a delete. */
function BlockerList({ blockers, name, personId }: { blockers: DeleteBlocker[]; name: string; personId: string }) {
  const timeZone = useOrgTimeZone();
  const time = (iso: string) => formatDateTime(iso, timeZone);
  return (
    <ul className="grid gap-2 text-muted-foreground" data-testid="contact-delete-blockers">
      {blockers.map((blocker) => (
        <li key={blocker.reason} className="grid gap-1">
          <span>{blockerText(blocker, name, time)}</span>
          {blocker.reason === "open_deals" && (
            <ul className="grid gap-1">
              {blocker.deals.map((deal) => (
                <li key={deal.id}>
                  <Link href={dealHref(deal.id, `/crm/contacts/${personId}`)} className="text-foreground underline underline-offset-4 hover:no-underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
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

/** One answer of the API, with its status code: a 404 after a sent delete means the delete went through. */
async function request(url: string, method: "GET" | "DELETE"): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetch(url, { method }).catch(() => null);
  if (!response) throw new Error("Could not reach the server.");
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, body };
}

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
    request(`/api/contacts/${personId}/delete-preview`, "GET")
      .then(({ status: code, body }) => {
        if (!live) return;
        if (code === 404) {
          toast.error(goneText(initialName));
          onOpenChange(false);
          router.replace("/crm/contacts");
          return;
        }
        if (code !== 200 || !body) return setStatus({ kind: "text", text: typeof body?.error === "string" ? body.error : "Could not read what the delete removes. Try again." });
        const next = body as unknown as DeletePreview;
        setPreview(next);
        setCounts(next.counts);
        if (next.blockers.length > 0) setStatus({ kind: "blocked", blockers: next.blockers });
      })
      .catch((error: unknown) => live && setStatus({ kind: "text", text: error instanceof Error ? error.message : "Could not reach the server." }));
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
    const { status: code, body } = await request(`/api/contacts/${personId}?${expectedQuery(counts)}`, "DELETE");
    if (code === 200 || code === 404) return done();
    const reason = typeof body?.code === "string" ? body.code : null;
    if (reason === "contact_blocked" && Array.isArray(body?.blockers)) {
      setStatus({ kind: "blocked", blockers: body.blockers as DeleteBlocker[] });
      return false;
    }
    if (reason === "counts_changed" && body?.counts) {
      setCounts(body.counts as DeleteCounts);
      setStatus({ kind: "text", text: countsChangedText(name) });
      return false;
    }
    if (reason === "try_again") {
      setStatus({ kind: "text", text: tryAgainText(name) });
      return false;
    }
    if (typeof body?.error === "string") {
      setStatus({ kind: "text", text: body.error });
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
                      className="text-foreground underline underline-offset-4 hover:no-underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
