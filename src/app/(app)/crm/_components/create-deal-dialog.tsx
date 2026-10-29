"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { ReachFlag } from "@/components/shell/reach-flag";
import { Button, buttonVariants } from "@/components/ui/button";
import { callApi } from "@/app/_lib/api-client";
import {
  CREATE_CHUNK,
  PREVIEW_CHUNK,
  applyRetry,
  bulkEffectsText,
  bulkReportText,
  contactDealText,
  defaultTitle,
  mergeReports,
  needsSecondConfirm,
  newIdempotencyKey,
  permanenceText,
  retryableIds,
  secondConfirmText,
  singleEffectsText,
  sumPreviews,
  type BulkReport,
  type ConvertPreview,
} from "./deal-effects";
import { chunks } from "@/app/(app)/_components/chunks";
import { countOf, formatCount } from "@/shared/format-number";
import { DealFields, useDealStages } from "./deal-fields";
import { dealHref } from "./deal-href";
import { dealFieldsReady, dealRequestFields, firstOpenChoice, initialDealFields, type DealFieldValues, type DealMemberOption, type DealStageList } from "./deal-form";

/** The person a deal is for, with the flags the dialog shows (a flagged person can still get a deal). */
export interface CreateDealPerson {
  id: string;
  name: string | null;
  email: string | null;
  companyName: string | null;
  doNotContact?: boolean;
  suppressed?: boolean;
  /** Open deals the contact has now, for contact mode's "{Name} already has {n} open deals." Left out, the line does not show. */
  openDeals?: number;
}

export interface CreateDealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `lead` converts the lead and creates its first deal, and says first what that stops. `contact` adds a deal to a contact. */
  mode: "lead" | "contact";
  person: CreateDealPerson;
  /** Owner choices, from the organization's members. */
  members: DealMemberOption[];
  currentUserId: string;
  /** The pipeline's stages. Left out, the dialog loads them when it first opens. */
  stages?: DealStageList;
  /** Runs after the deal exists, in place of opening the deal page. */
  onCreated?: (dealId: string) => void;
}

const MAX_TITLE = 200;

function Flags({ person }: { person: CreateDealPerson }) {
  if (!person.doNotContact && !person.suppressed && person.email) return null;
  return (
    <div className="flex flex-wrap gap-1.5" aria-label="Flags">
      {person.doNotContact && <ReachFlag kind="do_not_contact" />}
      {person.suppressed && <ReachFlag kind="suppressed" />}
      {!person.email && <Badge variant="outline">No email</Badge>}
    </div>
  );
}

/** "Already a contact", with a link to the deal when the server named one and to the contact otherwise. */
function AlreadyContact({ dealId, personId }: { dealId: string | null; personId: string }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <span>Already a contact.</span>
      <Link href={dealId ? `/crm/deals/${dealId}` : `/crm/contacts/${personId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
        {dealId ? "Open deal" : "Open contact"}
      </Link>
    </div>
  );
}

/**
 * Create deal for one person. In `lead` mode the dialog previews the conversion and posts to
 * `/api/leads/[id]/convert`; in `contact` mode it posts to `/api/deals`. Both send one idempotency key per dialog open,
 * so a retry after a lost response does not create a second deal. Errors stay in the dialog; `already_converted` shows
 * as a link. On success the dialog opens the deal page, or calls `onCreated`.
 */
export function CreateDealDialog({ open, onOpenChange, mode, person, members, currentUserId, stages: givenStages, onCreated }: CreateDealDialogProps) {
  const router = useRouter();
  const name = person.name?.trim() || person.email || (mode === "lead" ? "this lead" : "this contact");
  const initial = () => initialDealFields(defaultTitle(person.name ?? person.email, person.companyName).slice(0, MAX_TITLE), currentUserId);
  const [values, setValues] = useState<DealFieldValues>(initial);
  const [preview, setPreview] = useState<ConvertPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [already, setAlready] = useState<{ dealId: string | null } | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const key = useRef("");
  const { stages, error: stagesError } = useDealStages(open, givenStages);

  // Each open starts from a clean form.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValues(initial());
      setPreview(null);
      setPreviewError(null);
      setAlready(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    key.current = "";
    if (mode !== "lead") return;
    let live = true;
    void callApi<ConvertPreview>("/api/leads/convert/preview", "POST", { ids: [person.id] }).then((result) => {
      if (!live) return;
      if (result.ok && result.data) {
        setPreview(result.data);
        if (result.data.alreadyContacts > 0) setAlready({ dealId: null });
      } else setPreviewError(result.error ?? "Could not check what this changes. Try again.");
    });
    return () => {
      live = false;
    };
  }, [open, mode, person.id]);

  const form = { ...values, stage: values.stage ?? firstOpenChoice(stages) };
  const heldByPersonalCampaign = mode === "lead" && preview !== null && preview.skippedPersonalCampaign > 0;
  const ready = dealFieldsReady(form, stages, true) && !already && !heldByPersonalCampaign && (mode === "contact" || preview !== null);

  let description: string;
  if (mode === "contact") description = contactDealText(name, person.openDeals ?? 0);
  else if (previewError) description = previewError;
  else if (!preview) description = "Checking what this changes…";
  else if (already) description = "Nothing changed. Open the deal or the contact to add another deal there.";
  else if (heldByPersonalCampaign) description = "Another member's personal campaign holds this lead. Its creator or an admin can create the deal.";
  else description = `${singleEffectsText(name, preview)} ${permanenceText(name, { withDeal: true })}`;

  async function create(): Promise<boolean> {
    key.current ||= newIdempotencyKey();
    const fields = { ...dealRequestFields(form, true), idempotencyKey: key.current };
    const result =
      mode === "lead"
        ? await callApi<{ dealId: string }>(`/api/leads/${person.id}/convert`, "POST", fields)
        : await callApi<{ dealId: string }>("/api/deals", "POST", { ...fields, personId: person.id });
    if (!result.ok || !result.data) {
      if (result.code === "already_converted") {
        setAlready({ dealId: typeof result.details?.dealId === "string" ? result.details.dealId : null });
        return false;
      }
      throw new Error(result.error ?? "Could not create the deal. Try again.");
    }
    toast.success(mode === "lead" ? `Created deal. ${name} is a contact now.` : "Created deal.");
    if (onCreated) onCreated(result.data.dealId);
    // The deal page goes back to the page the dialog opened on, when that page is on its allowlist.
    else router.push(dealHref(result.data.dealId, `${window.location.pathname}${window.location.search}`));
    return true;
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Create deal for ${name}`}
      description={description}
      confirmLabel="Create deal"
      pendingLabel="Creating…"
      confirmDisabled={!ready}
      className="sm:max-w-md"
      onConfirm={create}
    >
      <Flags person={person} />
      {already && <AlreadyContact dealId={already.dealId} personId={person.id} />}
      {stagesError && (
        <p role="alert" className="text-sm text-destructive">
          {stagesError}
        </p>
      )}
      {!already && <DealFields idPrefix={`deal-${person.id}`} values={form} onChange={setValues} stages={stages} members={members} currentUserId={currentUserId} full />}
    </ConfirmDialog>
  );
}

/** A Create deal button with its dialog. */
export function CreateDealButton({
  label = "Create deal",
  variant = "default",
  size = "default",
  className,
  ...props
}: Omit<CreateDealDialogProps, "open" | "onOpenChange"> & { label?: string; variant?: "default" | "outline"; size?: "default" | "sm"; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} className={className} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <CreateDealDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}

export interface CreateDealsBulkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected people, as a stable array (a new array reloads the preview). Contacts among them are skipped and counted. */
  ids: readonly string[];
  members: DealMemberOption[];
  currentUserId: string;
  stages?: DealStageList;
  /** Runs with the merged report once every chunk is done. */
  onDone?: (report: BulkReport) => void;
}

/**
 * Create deals for many leads: stage and owner only, the title defaults per person. The preview sums chunks of 500;
 * the create sends chunks of 200 one after another and merges the reports, so the counts add up to the selection.
 * The dialog stays open with the report when it is done.
 */
export function CreateDealsBulkDialog({ open, onOpenChange, ids, members, currentUserId, stages: givenStages, onDone }: CreateDealsBulkDialogProps) {
  const router = useRouter();
  const [values, setValues] = useState<DealFieldValues>(() => initialDealFields("", currentUserId));
  const [preview, setPreview] = useState<ConvertPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [report, setReport] = useState<BulkReport | null>(null);
  /** Above 50 leads, the first Create asks once more before anything converts. */
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [wasOpen, setWasOpen] = useState(open);
  const { stages, error: stagesError } = useDealStages(open, givenStages);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setValues(initialDealFields("", currentUserId));
      setPreview(null);
      setPreviewError(null);
      setProgress({ done: 0, total: 0 });
      setReport(null);
      setStep("form");
    }
  }

  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      const parts: ConvertPreview[] = [];
      for (const chunk of chunks(ids, PREVIEW_CHUNK)) {
        const result = await callApi<ConvertPreview>("/api/leads/convert/preview", "POST", { ids: chunk });
        if (!live) return;
        if (!result.ok || !result.data) return setPreviewError(result.error ?? "Could not check what this changes. Try again.");
        parts.push(result.data);
      }
      setPreview(sumPreviews(parts));
    })();
    return () => {
      live = false;
    };
  }, [open, ids]);

  const form = { ...values, stage: values.stage ?? firstOpenChoice(stages) };
  const ready = dealFieldsReady(form, stages, false) && preview !== null && preview.people > 0 && report === null;
  const count = countOf(ids.length, "lead");

  const second = preview !== null && needsSecondConfirm(preview) ? secondConfirmText(preview.people) : null;
  const confirming = second !== null && step === "confirm" && report === null;

  async function create(): Promise<boolean> {
    if (second && step === "form") {
      setStep("confirm");
      return false;
    }
    const fields = dealRequestFields(form, false);
    const parts = chunks(ids, CREATE_CHUNK);
    const reports: BulkReport[] = [];
    setProgress({ done: 0, total: ids.length });
    for (const chunk of parts) {
      const result = await callApi<BulkReport>("/api/leads/convert", "POST", { ids: chunk, ...fields });
      if (!result.ok || !result.data) {
        const merged = mergeReports(reports);
        setReport(merged);
        router.refresh();
        throw new Error(`${result.error ?? "Something went wrong."} ${merged.created.length > 0 ? `${bulkReportText(merged)} ` : ""}Try again for the rest; people who already have a deal are skipped.`);
      }
      reports.push(result.data);
      setProgress((p) => ({ ...p, done: p.done + chunk.length }));
    }
    let merged = mergeReports(reports);
    // One more pass for the ids a chunk could not finish (a lock or its time budget). Whatever is still left is reported.
    const again = retryableIds(merged);
    for (const chunk of chunks(again, CREATE_CHUNK)) {
      const result = await callApi<BulkReport>("/api/leads/convert", "POST", { ids: chunk, ...fields });
      if (!result.ok || !result.data) break;
      merged = applyRetry(merged, result.data);
    }
    setReport(merged);
    toast.success(bulkReportText(merged));
    onDone?.(merged);
    router.refresh();
    return false;
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Create deals for ${count}`}
      description={confirming ? second.question : (previewError ?? (preview ? bulkEffectsText(preview) : "Checking what this changes…"))}
      confirmLabel={confirming ? second.confirm : "Create deals"}
      cancelLabel={report ? "Close" : "Cancel"}
      pendingLabel={progress.total > 0 ? `Creating… ${formatCount(progress.done)} of ${formatCount(progress.total)}` : "Creating…"}
      confirmDisabled={!ready}
      className="sm:max-w-md"
      back={confirming ? { label: "Back", onClick: () => setStep("form") } : undefined}
      onConfirm={create}
    >
      {confirming ? (
        <div className="grid gap-2 text-sm" data-testid="bulk-second-confirm">
          {second.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      ) : report ? (
        <p role="status" className="text-sm">
          {bulkReportText(report)}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Each deal is titled with the company and the name of its person.</p>
          {stagesError && (
            <p role="alert" className="text-sm text-destructive">
              {stagesError}
            </p>
          )}
          <DealFields idPrefix="bulk-deal" values={form} onChange={setValues} stages={stages} members={members} currentUserId={currentUserId} full={false} />
        </>
      )}
    </ConfirmDialog>
  );
}
