"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { orThrow, runApiAction } from "@/app/_lib/api-action";
import { callApi } from "@/app/_lib/api-client";
import { DNC_REASON_REQUIRED } from "@/app/(app)/_components/person/dnc-control";
import { saveDraftEdits, unsavedEditsError } from "../_lib/draft-edits";

const OPEN_STOP_EVENT = "miasdr:open-stop-contacting";

/** Opens Stop contacting from elsewhere on the thread, such as Review stop request on the type line. */
export function openStopContacting() {
  window.dispatchEvent(new Event(OPEN_STOP_EVENT));
}

/** Listens for `openStopContacting`. Returns the cleanup. */
export function onOpenStopContacting(open: () => void) {
  window.addEventListener(OPEN_STOP_EVENT, open);
  return () => window.removeEventListener(OPEN_STOP_EVENT, open);
}

export interface StopTarget {
  recordId: string;
  conversationId: string;
  channel: string;
  personId: string;
  personName: string;
  email: string | null;
  suppressed: boolean;
}

type Scope = "everywhere" | "address";

const EVERYWHERE = "Email and LinkedIn stop, campaign enrollments end and open drafts retire. You can clear it later, but stopped campaigns do not restart.";
const ADDRESS = "No campaign or reply can email this address again, and the suppression list keeps it. LinkedIn stays open.";

/**
 * How far a stop reaches and why, shared by Stop contacting and by Change type to the stop request type, so both ask the
 * same questions and make the same calls. Every channel needs a reason; the address alone does not.
 */
export function useStopScope(target: StopTarget) {
  const canSuppress = target.channel === "email" && target.email !== null && !target.suppressed;
  const [scope, setScope] = useState<Scope>("everywhere");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);

  function reset() {
    setScope("everywhere");
    setReason("");
    setReasonError(false);
  }

  /** False, with the error shown, while every channel is chosen and no reason is typed. */
  function ready(): boolean {
    const ok = scope !== "everywhere" || reason.trim() !== "";
    setReasonError(!ok);
    return ok;
  }

  /** Stops contact as chosen and says what happened. Call `ready` first; throws when the server refuses. */
  async function stop(): Promise<string> {
    orThrow(await runApiAction(scope === "everywhere" ? callApi(`/api/people/${target.personId}/dnc`, "POST", { enabled: true, reason: reason.trim() }) : callApi(`/api/inbox/${target.conversationId}/suppress`, "POST")));
    return scope === "everywhere" ? `Marked ${target.personName} do not contact.` : `Added ${target.email} to the suppression list.`;
  }

  const fields = (
    <>
      {canSuppress && (
        <RadioGroup value={scope} onValueChange={(v) => setScope(v as Scope)}>
          <Field orientation="horizontal">
            <RadioGroupItem value="everywhere" id={`stop-${target.recordId}-everywhere`} />
            <FieldContent>
              <FieldLabel htmlFor={`stop-${target.recordId}-everywhere`}>Every channel</FieldLabel>
              <FieldDescription>{EVERYWHERE}</FieldDescription>
            </FieldContent>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem value="address" id={`stop-${target.recordId}-address`} />
            <FieldContent>
              <FieldLabel htmlFor={`stop-${target.recordId}-address`} className="break-all">
                Only {target.email}
              </FieldLabel>
              <FieldDescription>{ADDRESS}</FieldDescription>
            </FieldContent>
          </Field>
        </RadioGroup>
      )}
      {scope === "everywhere" && (
        <Field>
          <FieldLabel htmlFor={`stop-reason-${target.recordId}`}>Reason</FieldLabel>
          <Input
            id={`stop-reason-${target.recordId}`}
            value={reason}
            maxLength={500}
            placeholder="Asked to stop, competitor, wrong person"
            aria-invalid={reasonError ? true : undefined}
            onChange={(e) => {
              setReason(e.target.value);
              setReasonError(false);
            }}
          />
          {reasonError && <FieldError>{DNC_REASON_REQUIRED}</FieldError>}
        </Field>
      )}
    </>
  );

  return { canSuppress, fields, ready, stop, reset, description: canSuppress ? "Choose how far the stop reaches." : EVERYWHERE };
}

/**
 * One way to stop contact, with its reach chosen in the dialog: every channel (do not contact, which can be cleared later) or
 * only the email address (the suppression list, which stays). The confirm says which one lasts, and only it is red.
 */
export function StopContactingDialog({ open, onOpenChange, onDone, ...target }: StopTarget & { open: boolean; onOpenChange: (open: boolean) => void; onDone: (message: string) => void }) {
  const stopScope = useStopScope(target);

  function change(next: boolean) {
    onOpenChange(next);
    if (!next) stopScope.reset();
  }

  async function confirm() {
    if (!stopScope.ready()) return false;
    const unsaved = await saveDraftEdits();
    if (unsaved) throw new Error(unsavedEditsError(unsaved));
    const done = await stopScope.stop();
    change(false);
    onDone(done);
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={change}
      title={`Stop contacting ${target.personName}?`}
      description={stopScope.description}
      confirmLabel="Stop contacting"
      cancelLabel="Keep contacting"
      pendingLabel="Stopping…"
      destructive
      className="sm:max-w-md"
      onConfirm={confirm}
    >
      <FieldGroup>{stopScope.fields}</FieldGroup>
    </ConfirmDialog>
  );
}
