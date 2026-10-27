"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { callApi } from "@/app/_lib/api-client";
import { cn } from "@/components/ui/utils";
import { dayFromToday, DueField, useBrowserZone } from "@/app/(app)/_components/person/tasks-panel";
import { saveDraftEdits, unsavedEditsError } from "../_lib/draft-edits";
import type { NextInQueue } from "../_lib/next-queue";
import { onOpenStopContacting, StopContactingDialog } from "./stop-contacting";

export interface NextStepProps {
  recordId: string;
  conversationId: string;
  channel: string;
  personId: string;
  personName: string;
  firstName: string;
  /** The record's reply type, the reason Done starts with. */
  typeName: string | null;
  closed: boolean;
  closedReason: string | null;
  doNotContact: boolean;
  email: string | null;
  suppressed: boolean;
  currentUserId: string;
  /** `?stop=1` in the URL: Stop contacting opens on load. */
  stopOnLoad?: boolean;
  /** The item after this one in the Actions view the thread came from, null when nothing else waits. Absent outside a queue. */
  next?: NextInQueue | null;
}

/**
 * What happens to the person after this reply, in one place under the reply: the three ways to finish without replying.
 * Remind me adds a task, Done ends reply handling (Reopen undoes it), and Stop contacting ends contact on every channel or for
 * the email address. Answering is the reply above, and the reply type sits on the type line under the latest message. After a
 * step taken here, the next item of the queue is one tap away, as after a send.
 */
export function NextStepClient(props: NextStepProps) {
  const { recordId, personName, closed } = props;
  const router = useRouter();
  const [mode, setMode] = useState<"follow" | "done" | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [decided, setDecided] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const canStop = !props.doNotContact;

  useEffect(() => {
    if (!canStop) return;
    return onOpenStopContacting(() => setStopOpen(true));
  }, [canStop]);

  // `?stop=1`, from a link that asks to review a stop request, opens the dialog once the page is interactive.
  const stopOnLoad = props.stopOnLoad === true && canStop;
  useEffect(() => {
    if (!stopOnLoad) return;
    const timer = setTimeout(() => setStopOpen(true), 0);
    return () => clearTimeout(timer);
  }, [stopOnLoad]);

  // The status region below announces the outcome, so no toast repeats it.
  function finish(message: string) {
    setMode(null);
    setError(null);
    setDecided(message);
    router.refresh();
  }

  async function reopen() {
    setPending(true);
    setError(null);
    const result = await callApi(`/api/records/${recordId}/reopen`, "POST");
    setPending(false);
    if (!result.ok) return setError(result.error ?? "Reply handling did not reopen. Try again.");
    setDecided(null);
    toast.success("Reopened.");
    router.refresh();
  }

  const toggle = (next: "follow" | "done") => {
    setError(null);
    setMode((current) => (current === next ? null : next));
  };

  return (
    <section aria-labelledby="next-step-title" className="stack-group" data-testid="next-step">
      <h2 id="next-step-title" className="text-sm font-semibold">
        Next step
      </h2>

      {closed ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" data-testid="reply-handling">
          <p>Done{props.closedReason ? `: ${props.closedReason}.` : "."} Follow-ups are off and no draft waits.</p>
          <Button size="sm" variant="outline" disabled={pending} className="max-sm:h-11" onClick={() => void reopen()}>
            {pending ? "Reopening…" : "Reopen"}
          </Button>
        </div>
      ) : (
        <>
          <div role="group" aria-label={`Finish without replying to ${personName}`} className="flex flex-wrap gap-2 max-sm:[&>*]:h-11">
            <Button size="sm" variant={mode === "follow" ? "secondary" : "outline"} aria-expanded={mode === "follow"} onClick={() => toggle("follow")}>
              Remind me
            </Button>
            <Button size="sm" variant={mode === "done" ? "secondary" : "outline"} aria-expanded={mode === "done"} onClick={() => toggle("done")}>
              Done, no reply needed
            </Button>
            {canStop && (
              <Button size="sm" variant="outline" onClick={() => setStopOpen(true)}>
                Stop contacting…
              </Button>
            )}
          </div>
          {mode === "follow" && <FollowUpForm recordId={recordId} firstName={props.firstName} currentUserId={props.currentUserId} onCancel={() => setMode(null)} onDone={finish} />}
          {mode === "done" && <DoneForm recordId={recordId} personName={personName} typeName={props.typeName} onCancel={() => setMode(null)} onDone={finish} />}
        </>
      )}

      {canStop && (
        <StopContactingDialog
          recordId={recordId}
          conversationId={props.conversationId}
          channel={props.channel}
          personId={props.personId}
          personName={personName}
          email={props.email}
          suppressed={props.suppressed}
          open={stopOpen}
          onOpenChange={setStopOpen}
          onDone={finish}
        />
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {/* One live region, present before its text changes, so the outcome is announced and not only shown. */}
      <div role="status" className="flex flex-wrap items-center gap-2 text-sm empty:hidden" data-testid="next-step-status">
        {decided && (
          <>
            <span>{decided}</span>
            {props.next && (
              <Link href={props.next.href} className={cn(buttonVariants({ size: "sm" }), "max-sm:h-11")} data-testid="next-step-next" aria-keyshortcuts="]">
                Next: {props.next.name}
              </Link>
            )}
            {props.next === null && <span className="text-muted-foreground">Nothing else waits in this queue.</span>}
          </>
        )}
      </div>
    </section>
  );
}

/** Remind me: a task to come back to the person, due tomorrow unless you pick another day, assigned to you. */
function FollowUpForm({ recordId, firstName, currentUserId, onCancel, onDone }: { recordId: string; firstName: string; currentUserId: string; onCancel: () => void; onDone: (message: string) => void }) {
  const zone = useBrowserZone();
  const [name, setName] = useState(`Follow up with ${firstName}`);
  const [dueDay, setDueDay] = useState(() => dayFromToday(1));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return setError("Name the task first.");
    setPending(true);
    setError(null);
    const result = await callApi(`/api/records/${recordId}/tasks`, "POST", { name, dueDay: dueDay || null, timeZone: zone ?? "UTC", assigneeId: currentUserId });
    setPending(false);
    if (!result.ok) return setError(result.error ?? "The reminder was not added. Try again.");
    onDone("Reminder added.");
  }

  return (
    <form onSubmit={submit} noValidate data-testid="follow-up-form">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`follow-up-${recordId}`}>Task</FieldLabel>
          <Input id={`follow-up-${recordId}`} autoFocus value={name} maxLength={200} className="max-w-md max-sm:h-11" onChange={(e) => setName(e.target.value)} aria-invalid={error ? true : undefined} />
          <FieldDescription>While the task is open, this conversation leaves Next steps in Actions and the task waits under Tasks.</FieldDescription>
        </Field>
        <DueField id={`follow-up-due-${recordId}`} value={dueDay} onChange={setDueDay} />
        {error && <FieldError>{error}</FieldError>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={pending || zone === null} className="max-sm:h-11">
            {pending ? "Adding…" : "Add reminder"}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} className="max-sm:h-11" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

/**
 * Ends reply handling without a reply. The reason starts as the reply type, which is the usual reason, so a not-interested reply is
 * one Enter away. Reopen undoes it, so the confirm is not red.
 */
function DoneForm({ recordId, personName, typeName, onCancel, onDone }: { recordId: string; personName: string; typeName: string | null; onCancel: () => void; onDone: (message: string) => void }) {
  const [reason, setReason] = useState(typeName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fieldId = `done-reason-${recordId}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim() === "") return setError("Say why no reply is needed.");
    setPending(true);
    setError(null);
    const unsaved = await saveDraftEdits();
    if (unsaved) {
      setPending(false);
      return setError(unsavedEditsError(unsaved));
    }
    const result = await callApi(`/api/records/${recordId}/close`, "POST", { reason: reason.trim() });
    setPending(false);
    if (!result.ok) return setError(result.error ?? "Reply handling did not close. Try again.");
    onDone(`Marked done for ${personName}.`);
  }

  return (
    <form onSubmit={submit} noValidate data-testid="done-form">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={fieldId}>Reason</FieldLabel>
          <Input
            id={fieldId}
            autoFocus
            value={reason}
            maxLength={500}
            placeholder="Went with a competitor"
            className="max-w-md max-sm:h-11"
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError(null);
            }}
          />
          <FieldDescription>Retires unsent drafts and stops follow-ups on every channel. Reopen brings reply handling back.</FieldDescription>
        </Field>
        {error && <FieldError>{error}</FieldError>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={pending} className="max-sm:h-11">
            {pending ? "Saving…" : "Mark done"}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} className="max-sm:h-11" onClick={onCancel}>
            Keep it open
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
