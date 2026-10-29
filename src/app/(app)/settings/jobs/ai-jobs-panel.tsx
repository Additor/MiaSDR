"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Time, useOrgTimeZone } from "@/components/shell/time";
import { callApi } from "@/app/_lib/api-client";
import { countOf, formatCount } from "@/shared/format-number";
import { formatDateTime } from "@/shared/format-time";
import { isRequeueableSkip } from "@/contexts/conversations/ai/domain/ai-job-requeue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/components/ui/utils";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface FailedAiJob {
  id: string;
  kind: "classification" | "initial_draft";
  attempts: number;
  lastError: string;
  failedAt: string;
  failureKind: "transient" | "lease" | "shape" | "permanent" | null;
  autoRequeues: number;
  manualRequeues: number;
  requeueCeiling: number;
  nextAutoRequeueAt: string | null;
}

interface SkippedAiJob {
  id: string;
  kind: "classification" | "initial_draft";
  reason: string;
  detail: string;
  skippedAt: string;
}

interface TickFailure {
  id: string;
  job: string;
  error: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

const KIND_LABEL = { classification: "Reply type pick", initial_draft: "Draft" } as const;
const WINDOWS = [
  { label: "the last hour", ms: 3_600_000 },
  { label: "the last 24 hours", ms: 86_400_000 },
  { label: "the last 7 days", ms: 7 * 86_400_000 },
  { label: "the last 30 days", ms: 30 * 86_400_000 },
];

const WINDOW_ITEMS = WINDOWS.map((w, i) => ({ value: String(i), label: w.label }));

function nextStep(job: FailedAiJob, timeZone: string): string {
  if (job.failureKind === "permanent") return "Needs a fix first (key, reply types or content). Not retried automatically.";
  if (job.failureKind === "shape") return "The AI answered in the wrong form. Not retried automatically.";
  if (!job.nextAutoRequeueAt) return `Automatic retries used up (${formatCount(job.autoRequeues)} of ${formatCount(job.requeueCeiling)}).`;
  return `Automatic retry after ${formatDateTime(job.nextAutoRequeueAt, timeZone)} (${formatCount(job.autoRequeues)} of ${formatCount(job.requeueCeiling)} used).`;
}

export function AiJobsPanel({ failed, skipped, tickFailures }: { failed: { total: number; rows: FailedAiJob[] }; skipped: { total: number; rows: SkippedAiJob[] }; tickFailures: TickFailure[] }) {
  const router = useRouter();
  const timeZone = useOrgTimeZone();
  const [busy, setBusy] = useState<string | null>(null);
  const [windowIndex, setWindowIndex] = useState(1);
  const [confirmingBulk, setConfirmingBulk] = useState(false);

  async function requeue(key: string, url: string, body?: unknown) {
    setBusy(key);
    const result = await callApi<{ requeued: number; more: boolean }>(url, "POST", body);
    setBusy(null);
    if (!result.ok || !result.data) toast.error(result.error ?? "Requeue failed.");
    else if (result.data.requeued === 0) toast.info("Nothing to requeue. The job is not failed or skipped any more.");
    else toast.success(`Requeued ${countOf(result.data.requeued, "job")}.${result.data.more ? " More remain. Run it again." : ""}`);
    router.refresh();
  }

  return (
    <>
      <SettingsSection
        title="Failed AI jobs"
        description={
          failed.total === 0
            ? "No failed reply type or draft jobs."
            : `${formatCount(failed.total)} failed. Provider outages and timeouts retry automatically with growing waits. Requeueing by hand gives a job fresh attempts and is recorded with your name.`
        }
      >
        {failed.total > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <FieldLabel htmlFor="requeue-window" className="font-normal text-muted-foreground">
              Requeue everything that failed in
            </FieldLabel>
            <Select items={WINDOW_ITEMS} value={String(windowIndex)} onValueChange={(v) => v && setWindowIndex(Number(v))}>
              <SelectTrigger id="requeue-window" size="sm" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOW_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" disabled={busy !== null} onClick={() => setConfirmingBulk(true)}>
              {busy === "since" ? "Requeueing…" : "Requeue failed jobs"}
            </Button>
            <ConfirmDialog
              open={confirmingBulk}
              onOpenChange={setConfirmingBulk}
              title={`Requeue jobs that failed in ${WINDOWS[windowIndex].label}?`}
              description="Each reply type and draft job that failed in that time gets fresh attempts and runs again on the next ticks, which calls the AI provider again. The requeue is recorded with your name."
              confirmLabel="Requeue failed jobs"
              onConfirm={() => void requeue("since", "/api/jobs/ai/requeue", { since: new Date(Date.now() - WINDOWS[windowIndex].ms).toISOString() })}
            />
          </div>
        )}
        {failed.rows.length > 0 && (
          <ul className={cn(RULED_LIST, "text-sm")}>
            {failed.rows.map((job) => (
              <li key={job.id} className={cn(RULED_ROW, "grid gap-0.5")}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{KIND_LABEL[job.kind]}</span>
                  <span className="text-muted-foreground">
                    failed <Time value={job.failedAt} /> after {countOf(job.attempts, "attempt")}
                    {job.manualRequeues > 0 ? `, requeued by hand ${countOf(job.manualRequeues, "time")}` : ""}
                  </span>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => requeue(job.id, `/api/jobs/ai/${job.id}/requeue`)}>
                    {busy === job.id ? "Requeueing…" : "Requeue"}
                  </Button>
                </div>
                <p className="text-destructive">{job.lastError}</p>
                <p className="text-muted-foreground">{nextStep(job, timeZone)}</p>
              </li>
            ))}
          </ul>
        )}
        {failed.total > failed.rows.length && <p className="text-xs text-muted-foreground">Showing the newest {formatCount(failed.rows.length)} of {formatCount(failed.total)}.</p>}
      </SettingsSection>

      <SettingsSection
        title="Skipped AI jobs"
        description={
          skipped.total === 0
            ? "No AI job was skipped."
            : `${formatCount(skipped.total)} skipped because the daily limit for unknown senders (set under Reply handling) was used up. The sweep never retries them. Raise the limit or wait a day, then requeue.`
        }
      >
        {skipped.rows.length > 0 && (
          <ul className={cn(RULED_LIST, "text-sm")}>
            {skipped.rows.map((job) => (
              <li key={job.id} className={cn(RULED_ROW, "grid gap-0.5")}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{KIND_LABEL[job.kind]}</span>
                  <span className="text-muted-foreground">skipped <Time value={job.skippedAt} />, reason {job.reason}</span>
                  {isRequeueableSkip({ status: "skipped", skipReason: job.reason }) && (
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => requeue(job.id, `/api/jobs/ai/${job.id}/requeue`)}>
                      {busy === job.id ? "Requeueing…" : "Requeue"}
                    </Button>
                  )}
                </div>
                <p className="text-muted-foreground">{job.detail}</p>
              </li>
            ))}
          </ul>
        )}
        {skipped.total > skipped.rows.length && <p className="text-xs text-muted-foreground">Showing the newest {formatCount(skipped.rows.length)} of {formatCount(skipped.total)}.</p>}
      </SettingsSection>

      <SettingsSection title="Background job failures" description="Errors and failed items from scheduler ticks. A repeating failure updates one line here.">
        {tickFailures.length === 0 ? (
          <p className="text-sm text-muted-foreground">No failures recorded.</p>
        ) : (
          <ul className={cn(RULED_LIST, "text-sm")}>
            {tickFailures.map((f) => (
              <li key={f.id} className={cn(RULED_ROW, "grid gap-0.5")}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{f.job}</span>
                  <span className="text-muted-foreground">
                    first <Time value={f.firstSeenAt} />, last <Time value={f.lastSeenAt} />
                  </span>
                </div>
                <p className="text-destructive">{f.error}</p>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </>
  );
}
