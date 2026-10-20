"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callApi } from "@/lib/api-client";

interface DncResult {
  changed: boolean;
  enrollmentsStopped: number;
  draftsRetired: number;
}

export const DNC_REASON_REQUIRED = "Type a reason to mark this person do not contact.";

const OPEN_DNC_EVENT = "miasdr:open-dnc";

/**
 * Opens the do not contact control of `personId` with its Reason field focused, as the contact delete dialog's "mark them do
 * not contact" does. The control waits until no dialog is open, since a closing dialog hands focus back to its trigger.
 */
export function openDncControl(personId: string) {
  window.dispatchEvent(new CustomEvent<string>(OPEN_DNC_EVENT, { detail: personId }));
}

/**
 * The do-not-contact toggle every page shares (lead, contact, deal, Inbox thread). Setting it stops the person's campaign
 * enrollments and retires open drafts. A quiet button opens the reason field, and only the confirm button is red, so the
 * rarest action is not the loudest thing on the page. The confirm button stays enabled; a missing reason is said on click.
 */
export function DncControl({ personId, doNotContact }: { personId: string; doNotContact: boolean }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const fieldId = `dnc-reason-${personId}`;
  const reasonRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    function onRequest(event: Event) {
      if ((event as CustomEvent<string>).detail !== personId || doNotContact) return;
      setOpen(true);
      clearInterval(timer);
      const started = Date.now();
      timer = setInterval(() => {
        const dialogOpen = document.querySelector('[data-slot="dialog-content"]') !== null;
        if ((dialogOpen || !reasonRef.current) && Date.now() - started < 2000) return;
        clearInterval(timer);
        reasonRef.current?.scrollIntoView({ block: "center" });
        reasonRef.current?.focus();
      }, 50);
    }
    window.addEventListener(OPEN_DNC_EVENT, onRequest);
    return () => {
      window.removeEventListener(OPEN_DNC_EVENT, onRequest);
      clearInterval(timer);
    };
  }, [personId, doNotContact]);

  async function submit(enabled: boolean) {
    if (enabled && reason.trim() === "") return setError(DNC_REASON_REQUIRED);
    setPending(true);
    setError(null);
    const result = await callApi<DncResult>(`/api/crm/people/${personId}/dnc`, "POST", { enabled, reason: enabled ? reason : null });
    setPending(false);
    if (!result.ok || !result.data) return setError(result.error);
    setReason("");
    setOpen(false);
    toast.success(
      enabled
        ? `Marked do not contact. ${result.data.enrollmentsStopped} campaign enrollment${result.data.enrollmentsStopped === 1 ? "" : "s"} stopped, ${result.data.draftsRetired} draft${result.data.draftsRetired === 1 ? "" : "s"} retired.`
        : "Cleared do not contact.",
    );
    router.refresh();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(true);
  }

  return (
    <div className="grid gap-2">
      {doNotContact ? (
        <div>
          <Button variant="outline" size="sm" disabled={pending} className="max-sm:h-11" onClick={() => void submit(false)}>
            Clear do not contact
          </Button>
        </div>
      ) : !open ? (
        <div>
          <Button variant="outline" size="sm" className="max-sm:h-11" onClick={() => setOpen(true)}>
            Mark do not contact
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="grid gap-2" noValidate>
          <div className="stack-field">
            <Label htmlFor={fieldId}>Reason</Label>
            <Input
              id={fieldId}
              ref={reasonRef}
              autoFocus
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error === DNC_REASON_REQUIRED) setError(null);
              }}
              maxLength={500}
              placeholder="Asked to stop, competitor, wrong person"
              aria-invalid={error === DNC_REASON_REQUIRED ? true : undefined}
              aria-describedby={error ? `${fieldId}-error` : undefined}
              className="max-sm:h-11"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={pending} className="max-sm:h-11">
              Confirm do not contact
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              className="max-sm:h-11"
              onClick={() => {
                setOpen(false);
                setReason("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
