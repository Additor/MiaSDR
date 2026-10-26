"use client";

import { SparklesIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { callApi } from "@/app/_lib/api-client";
import { cn } from "@/components/ui/utils";
import { DNC_REASON_REQUIRED } from "@/app/(app)/_components/person/dnc-control";
import { StateTip } from "@/app/(app)/_components/person/state-tip";
import { dayFromToday, DueField, useBrowserZone } from "@/app/(app)/_components/person/tasks-panel";
import { saveDraftEdits } from "../_lib/draft-edits";
import type { NextInQueue } from "../_lib/next-queue";
import { ChangeCategoryButton, type AiReading, type StageOption } from "./change-category-button";

const OPEN_STOP_EVENT = "miasdr:open-stop-contacting";

/** Opens Stop contacting from elsewhere on the thread, such as the stop request under the AI's reading. */
export function openStopContacting() {
  window.dispatchEvent(new Event(OPEN_STOP_EVENT));
}

export interface NextStepProps {
  recordId: string;
  conversationId: string;
  channel: string;
  personId: string;
  personName: string;
  firstName: string;
  category: { label: string | null; source: string | null; locked: boolean; replyTypeId: string | null };
  contextVersion: number;
  stages: StageOption[];
  aiReading: AiReading | null;
  closed: boolean;
  closedReason: string | null;
  doNotContact: boolean;
  email: string | null;
  suppressed: boolean;
  currentUserId: string;
  /** The item after this one in the Actions view the thread came from, null when nothing else waits. Absent outside a queue. */
  next?: NextInQueue | null;
}

/**
 * What happens to the person after this reply, in one place under the reply: the reply category with Change category, and the
 * three ways to finish without replying. Follow up later adds a task, Done ends reply handling (Reopen undoes it), and Stop
 * contacting ends contact on every channel or for the email address. Answering is the reply above. After a step taken here, the
 * next item of the queue is one tap away, as after a send.
 */
export function NextStepClient(props: NextStepProps) {
  const { recordId, personName, category, closed } = props;
  const router = useRouter();
  const [mode, setMode] = useState<"follow" | "done" | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [decided, setDecided] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const canStop = !props.doNotContact;

  useEffect(() => {
    function onOpen() {
      if (canStop) setStopOpen(true);
    }
    window.addEventListener(OPEN_STOP_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_STOP_EVENT, onOpen);
  }, [canStop]);

  function finish(message: string) {
    setMode(null);
    setError(null);
    setDecided(message);
    toast.success(message);
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
        Next step for {personName}
      </h2>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" data-testid="reply-category">
        <span className="text-muted-foreground">Category</span>
        <span className="flex items-center gap-1.5 font-medium">
          {category.label ?? "Not classified yet"}
          {category.source && (
            <StateTip trigger={<span tabIndex={0} className="inline-flex rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="category-source" />} tip={`Set by ${category.source === "ai" ? "the AI" : "a person"}`}>
              {category.source === "ai" ? <SparklesIcon aria-hidden className="size-3.5" /> : <UserIcon aria-hidden className="size-3.5" />}
            </StateTip>
          )}
        </span>
        {category.locked && (
          <Badge variant="outline" title="The AI cannot move this person out of Existing customer">
            Locked as Existing customer
          </Badge>
        )}
        {!closed && (
          <ChangeCategoryButton
            recordId={recordId}
            conversationId={props.conversationId}
            personName={personName}
            contextVersion={props.contextVersion}
            currentReplyTypeId={category.replyTypeId}
            replyTypeLocked={category.locked}
            stages={props.stages}
            aiReading={props.aiReading}
          />
        )}
      </div>

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
              Follow up later
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
          {mode === "done" && <DoneForm recordId={recordId} personName={personName} category={category.label} onCancel={() => setMode(null)} onDone={finish} />}
        </>
      )}

      {canStop && <StopContactingDialog {...props} open={stopOpen} onOpenChange={setStopOpen} onDone={finish} />}

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

/** A task to come back to the person, due tomorrow unless you pick another day, assigned to you. */
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
    if (!result.ok) return setError(result.error ?? "The task was not added. Try again.");
    onDone("Follow-up task added.");
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
            {pending ? "Adding…" : "Add follow-up"}
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
 * Ends reply handling without a reply. The reason starts as the category, which is the usual reason, so a not-interested reply is
 * one Enter away. Reopen undoes it, so the confirm is not red.
 */
function DoneForm({ recordId, personName, category, onCancel, onDone }: { recordId: string; personName: string; category: string | null; onCancel: () => void; onDone: (message: string) => void }) {
  const [reason, setReason] = useState(category ?? "");
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
      return setError(`Your draft edits were not saved, so nothing changed. ${unsaved}`);
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

/**
 * One way to stop contact, with its reach chosen in the dialog: every channel (do not contact, which can be cleared later) or
 * only the email address (the suppression list, which stays). The confirm says which one lasts, and only it is red.
 */
function StopContactingDialog({
  recordId,
  conversationId,
  channel,
  personId,
  personName,
  email,
  suppressed,
  open,
  onOpenChange,
  onDone,
}: NextStepProps & { open: boolean; onOpenChange: (open: boolean) => void; onDone: (message: string) => void }) {
  const canSuppress = channel === "email" && email !== null && !suppressed;
  const [scope, setScope] = useState<"everywhere" | "address">("everywhere");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const fieldId = `stop-reason-${recordId}`;

  function change(next: boolean) {
    onOpenChange(next);
    if (next) return;
    setScope("everywhere");
    setReason("");
    setReasonError(false);
  }

  async function confirm() {
    if (scope === "everywhere" && reason.trim() === "") {
      setReasonError(true);
      return false;
    }
    const unsaved = await saveDraftEdits();
    if (unsaved) throw new Error(`Your draft edits were not saved, so nothing changed. ${unsaved}`);
    const result =
      scope === "everywhere"
        ? await callApi(`/api/people/${personId}/dnc`, "POST", { enabled: true, reason: reason.trim() })
        : await callApi(`/api/inbox/${conversationId}/suppress`, "POST");
    if (!result.ok) throw new Error(result.error ?? "Contact did not stop. Try again.");
    change(false);
    onDone(scope === "everywhere" ? `Marked ${personName} do not contact.` : `Added ${email} to the suppression list.`);
  }

  const everywhere = "Email and LinkedIn stop, campaign enrollments end and open drafts retire. You can clear it later, but stopped campaigns do not restart.";
  const address = "No campaign or reply can email this address again, and the suppression list keeps it. LinkedIn stays open.";

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={change}
      title={`Stop contacting ${personName}?`}
      description={canSuppress ? "Choose how far the stop reaches." : everywhere}
      confirmLabel="Stop contacting"
      cancelLabel="Keep contacting"
      pendingLabel="Stopping…"
      destructive
      className="sm:max-w-md"
      onConfirm={confirm}
    >
      <FieldGroup>
        {canSuppress && (
          <RadioGroup value={scope} onValueChange={(v) => setScope(v as "everywhere" | "address")}>
            <Field orientation="horizontal">
              <RadioGroupItem value="everywhere" id={`${fieldId}-everywhere`} />
              <FieldContent>
                <FieldLabel htmlFor={`${fieldId}-everywhere`}>Every channel</FieldLabel>
                <FieldDescription>{everywhere}</FieldDescription>
              </FieldContent>
            </Field>
            <Field orientation="horizontal">
              <RadioGroupItem value="address" id={`${fieldId}-address`} />
              <FieldContent>
                <FieldLabel htmlFor={`${fieldId}-address`} className="break-all">
                  Only {email}
                </FieldLabel>
                <FieldDescription>{address}</FieldDescription>
              </FieldContent>
            </Field>
          </RadioGroup>
        )}
        {scope === "everywhere" && (
          <Field>
            <FieldLabel htmlFor={fieldId}>Reason</FieldLabel>
            <Input
              id={fieldId}
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
      </FieldGroup>
    </ConfirmDialog>
  );
}
