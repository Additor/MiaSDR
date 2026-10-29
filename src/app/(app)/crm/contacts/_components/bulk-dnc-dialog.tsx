"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { callApi } from "@/app/_lib/api-client";
import { DNC_CONSEQUENCE, DNC_REASON_REQUIRED } from "@/app/(app)/_components/person/dnc-control";
import { chunks } from "@/app/(app)/_components/chunks";
import { formatCount } from "@/shared/format-number";
import { bulkDncTitle, DNC_CHUNK, dncReportText, mergeDncReports, type DncReport } from "./contacts-bulk";

const DESCRIPTION = DNC_CONSEQUENCE;

/**
 * Bulk Mark do not contact: one reason for every ticked contact. The dialog sends chunks of 200 one after another and
 * adds up the reports, then stays open with the report, as Create deals does. `onClose` runs with the report once the person
 * closes a dialog that marked anything or got a report back, so the list refreshes and the selection clears.
 */
export function BulkDncDialog({ open, ids, onClose }: { open: boolean; ids: readonly string[]; onClose: (report: DncReport | null) => void }) {
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [report, setReport] = useState<DncReport | null>(null);
  const [wasOpen, setWasOpen] = useState(open);

  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setReason("");
      setFieldError(false);
      setProgress({ done: 0, total: 0 });
      setReport(null);
    }
  }

  async function mark(): Promise<boolean> {
    if (reason.trim() === "") {
      setFieldError(true);
      return false;
    }
    const reports: DncReport[] = [];
    setProgress({ done: 0, total: ids.length });
    for (const chunk of chunks(ids, DNC_CHUNK)) {
      const result = await callApi<DncReport>("/api/people/dnc", "POST", { ids: chunk, reason });
      if (!result.ok || !result.data) {
        if (reports.length > 0) {
          const merged = mergeDncReports(reports);
          setReport(merged);
          throw new Error(`${result.error ?? "Something went wrong."} ${dncReportText(merged)} Try again for the rest; people already marked are skipped.`);
        }
        throw new Error(result.error ?? "Something went wrong. Try again.");
      }
      reports.push(result.data);
      setProgress((p) => ({ ...p, done: p.done + chunk.length }));
    }
    setReport(mergeDncReports(reports));
    return false;
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => !next && onClose(report)}
      title={bulkDncTitle(ids.length)}
      description={DESCRIPTION}
      confirmLabel="Mark do not contact"
      cancelLabel={report ? "Close" : "Keep contacting"}
      pendingLabel={progress.total > DNC_CHUNK ? `Marking… ${formatCount(progress.done)} of ${formatCount(progress.total)}` : "Marking…"}
      destructive
      confirmDisabled={report !== null}
      className="sm:max-w-md"
      onConfirm={mark}
    >
      {report ? (
        <p role="status" className="text-sm" data-testid="bulk-dnc-report">
          {dncReportText(report)}
        </p>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            // Enter in the field does not submit: the footer's button does, so the dialog keeps its pending state.
            event.preventDefault();
          }}
        >
          <Field data-invalid={fieldError || undefined}>
            <FieldLabel htmlFor="bulk-dnc-reason">Reason</FieldLabel>
            <Input
              id="bulk-dnc-reason"
              autoFocus
              value={reason}
              maxLength={500}
              placeholder="Asked to stop, competitor, wrong person"
              aria-invalid={fieldError || undefined}
              aria-describedby={fieldError ? "bulk-dnc-reason-error" : undefined}
              touch
              onChange={(event) => {
                setReason(event.target.value);
                setFieldError(false);
              }}
            />
            {fieldError && <FieldError id="bulk-dnc-reason-error">{DNC_REASON_REQUIRED}</FieldError>}
          </Field>
        </form>
      )}
    </ConfirmDialog>
  );
}
