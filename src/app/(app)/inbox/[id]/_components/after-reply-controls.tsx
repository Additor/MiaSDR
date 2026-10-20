"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Time } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api-client";
import type { RecordAfterReply } from "@/contexts/conversations/after-reply/application/sequences";
import type { Json } from "@/app/(app)/crm/_components/serialize";

type State = Json<RecordAfterReply>;
type Command = "pause" | "resume" | "skip" | "cancel" | "restart";

const STEP_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  drafting: "Drafting",
  awaiting_review: "Draft waits for review",
  sent: "Sent",
  skipped: "Skipped",
  cancelled: "Cancelled",
  failed: "Failed",
};
const DONE_MESSAGE: Record<Command, string> = {
  pause: "Follow-ups paused.",
  resume: "Follow-ups resumed.",
  skip: "Step skipped.",
  cancel: "Follow-ups stopped.",
  restart: "Follow-ups restarted.",
};

/**
 * After a reply on one conversation: the campaign that owns it, the run status and steps, and the pause, resume, skip,
 * stop and restart controls. Follow-ups only write drafts, so nothing here sends. A person still approves every draft.
 * `disabledReason` turns every control off and says why (a contact gets no follow-ups).
 */
export function AfterReplyControls({ recordId, state, disabledReason = null }: { recordId: string; state: State; disabledReason?: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const { run, campaign } = state;
  const campaignLink = campaign ? `/campaigns/${campaign.id}#after-reply` : null;
  const locked = disabledReason !== null;
  const lockedNote = locked && (
    <p id="after-reply-disabled-reason" className="text-muted-foreground">
      {disabledReason}
    </p>
  );

  /** Sends one command and returns the problem to show, or null when it worked. */
  async function send(action: Command) {
    const result = await callApi(`/api/crm/records/${recordId}/after-reply`, "POST", { action });
    return result.ok ? null : (result.error ?? "Could not change the follow-ups. Try again.");
  }
  async function call(action: Command) {
    setPending(true);
    setError(null);
    const problem = await send(action);
    setPending(false);
    if (problem) return setError(problem);
    toast.success(DONE_MESSAGE[action]);
    router.refresh();
  }
  /** The confirmation dialog shows a failure itself, so this throws instead of using the inline error. */
  async function stopRun() {
    const problem = await send("cancel");
    if (problem) throw new Error(problem);
    toast.success(DONE_MESSAGE.cancel);
    router.refresh();
  }

  if (!run) {
    if (locked) return <div className="grid gap-1 text-sm">{lockedNote}</div>;
    return (
      <div className="grid gap-1 text-sm">
        {!campaign && <p className="text-muted-foreground">No campaign has emailed this person, so there is nothing to follow up on.</p>}
        {campaign && campaign.mode === "handoff" && campaignLink && (
          <>
            <p className="text-muted-foreground">This campaign hands replies to the Inbox. Turn on AI follow-ups in its After a reply setting.</p>
            <Link href={campaignLink} className="w-fit underline underline-offset-4">
              {campaign.name}
            </Link>
          </>
        )}
        {campaign && campaign.mode === "ai_drafts" && campaignLink && (
          <>
            <p className="text-muted-foreground">No follow-ups yet. They start when a reply from this person is classified.</p>
            <Link href={campaignLink} className="w-fit underline underline-offset-4">
              {campaign.name}
            </Link>
          </>
        )}
      </div>
    );
  }

  const live = run.status === "active" || run.status === "paused";
  // Handoff hides Restart. A campaign that drafts follow-ups shows it, disabled with the cause when it cannot start now.
  const showRestart = state.canRestart || campaign?.mode === "ai_drafts";
  const restartHelp = !locked && !state.canRestart ? state.restartBlockedReason : null;
  const off = pending || locked;
  return (
    <div className="grid gap-3 text-sm">
      {lockedNote}
      <div className="flex flex-wrap items-center gap-2">
        {campaign && campaignLink ? (
          <Link href={campaignLink} className="font-medium underline underline-offset-4">
            {campaign.name}
          </Link>
        ) : (
          <span className="font-medium">Campaign removed</span>
        )}
        <Badge variant={run.status === "active" ? "secondary" : "outline"}>{run.statusLabel}</Badge>
        <span className="text-xs text-muted-foreground">
          version {run.version}, {run.startedByLabel.toLowerCase()}
        </span>
      </div>
      {!live && run.endedReasonLabel && <p className="text-muted-foreground">{run.endedReasonLabel}.</p>}
      {campaign?.mode === "handoff" && campaignLink && (
        <p className="text-muted-foreground">
          This campaign now hands replies to the Inbox.{" "}
          <Link href={campaignLink} className="underline underline-offset-4">
            Open its After a reply setting
          </Link>
        </p>
      )}
      <ol className="grid gap-1">
        {run.steps.map((s) => (
          <li key={s.id} className="grid gap-0.5">
            <div className="flex items-center justify-between gap-2">
              <span>
                {s.position}. {s.name}
              </span>
              <Badge variant="outline" title={s.lastError ?? undefined}>
                {STEP_LABEL[s.status] ?? s.status}
              </Badge>
            </div>
            {(s.status === "scheduled" || s.status === "failed") && (
              <span className="text-xs text-muted-foreground">
                {s.status === "failed" && s.lastError ? `${s.lastError}. ` : ""}
                {s.status === "scheduled" && (
                  <>
                    Due <Time value={s.dueAt} />
                  </>
                )}
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        {run.status === "active" && (
          <Button size="sm" variant="outline" disabled={off} aria-describedby={locked ? "after-reply-disabled-reason" : undefined} onClick={() => call("pause")}>
            Pause follow-ups
          </Button>
        )}
        {run.status === "paused" && (
          <Button size="sm" variant="outline" disabled={off} aria-describedby={locked ? "after-reply-disabled-reason" : undefined} onClick={() => call("resume")}>
            Resume
          </Button>
        )}
        {live && (
          <Button size="sm" variant="outline" disabled={off} aria-describedby={locked ? "after-reply-disabled-reason" : undefined} onClick={() => call("skip")}>
            Skip step
          </Button>
        )}
        {live && (
          <Button size="sm" variant="destructive" disabled={off} aria-describedby={locked ? "after-reply-disabled-reason" : undefined} onClick={() => setConfirmStop(true)}>
            Stop follow-ups
          </Button>
        )}
        {showRestart && (
          <Button
            size="sm"
            variant="outline"
            disabled={off || !state.canRestart}
            onClick={() => call("restart")}
            title={disabledReason ?? restartHelp ?? "Starts the follow-ups again from the first step and replaces the current run"}
            aria-describedby={locked ? "after-reply-disabled-reason" : restartHelp ? "restart-blocked-reason" : undefined}
          >
            Restart follow-ups
          </Button>
        )}
      </div>
      {showRestart && restartHelp && (
        <p id="restart-blocked-reason" className="text-xs text-muted-foreground">
          {restartHelp}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop follow-ups?"
        description="The remaining steps are cancelled and drafts that wait for review are withdrawn. Stopped follow-ups cannot resume. Restart follow-ups starts them again from the first step."
        confirmLabel="Stop follow-ups"
        cancelLabel="Keep following up"
        pendingLabel="Stopping…"
        destructive
        onConfirm={stopRun}
      />
    </div>
  );
}
