"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/shell/status-badge";
import { Time } from "@/components/shell/time";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/api-client";
import { ConfirmDialog } from "@/components/shell/confirm-dialog";
import { cn } from "@/lib/utils";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface Overview {
  runs: Array<{ id: string; job: string; slot: string; status: string; organizationId: string | null; startedAt: string; finishedAt: string | null; error: string | null }>;
  backlog: { dead: number; retrying: number; queued: number };
  audit: Array<{ id: string; action: string; actorName: string | null; meta: Record<string, unknown>; createdAt: string }>;
}

const ACTION_LABEL: Record<string, string> = {
  "linkedin.webhooks_replayed": "Replayed failed webhooks",
  "linkedin.daily_counters_reset": "Reset daily counters",
  "linkedin.limits_changed": "Changed account limits",
  "linkedin.connect_link_created": "Created a connection link",
  "linkedin.reconnect_link_created": "Created a reconnect link",
  "linkedin.account_connected": "Account connected",
};

/** Webhook backlog and the daily counter reset: the LinkedIn actions an admin takes when something went wrong. */
export function LinkedInOperations({ overview }: { overview: Pick<Overview, "backlog"> }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"replay" | "reset" | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const waiting = overview.backlog.dead + overview.backlog.retrying + overview.backlog.queued;

  async function replay() {
    setBusy("replay");
    const result = await callApi<{ requeued: number; claimed: number; done: number; failed: number }>("/api/linkedin/jobs/replay-webhooks", "POST");
    setBusy(null);
    if (!result.ok || !result.data) toast.error(result.error ?? "Replay failed.");
    else toast.success(`Replayed ${result.data.claimed} deliveries: ${result.data.done} applied, ${result.data.failed} failed again.`);
    router.refresh();
  }

  async function reset() {
    setBusy("reset");
    const result = await callApi<{ accounts: number; pausesCleared: number; searchCountersCleared: number }>("/api/linkedin/jobs/reset-daily-limits", "POST");
    setBusy(null);
    if (!result.ok || !result.data) toast.error(result.error ?? "Reset failed.");
    else toast.success(`Reset ${result.data.accounts} account(s): ${result.data.pausesCleared} pause(s) and ${result.data.searchCountersCleared} search counter(s) cleared.`);
    router.refresh();
  }

  return (
    <>
      <SettingsSection
        title="Failed LinkedIn webhooks"
        description={
          <>
            {waiting === 0
              ? "No failed deliveries."
              : `${overview.backlog.dead} gave up, ${overview.backlog.retrying} wait for an automatic retry, ${overview.backlog.queued} are queued. Replaying an event twice never applies it twice.`}{" "}
            <Link href="/settings/inbound-events?source=linkedin" className="underline">
              Review them one by one
            </Link>
            .
          </>
        }
      >
        <div>
          <Button variant="outline" onClick={replay} disabled={busy !== null || waiting === 0}>
            {busy === "replay" ? "Replaying…" : "Replay failed webhooks"}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Daily counters"
        description="Clears the pause LinkedIn set after a limit error and the search lead counter, on every account. Invitation and message counts stay, so the daily caps keep protecting the accounts. The reset is recorded with your name."
      >
        <div>
          <Button variant="outline" onClick={() => setConfirmReset(true)} disabled={busy !== null}>
            {busy === "reset" ? "Resetting…" : "Reset daily counters"}
          </Button>
        </div>
      </SettingsSection>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset daily counters?"
        description="Clears the LinkedIn rate-limit pause and the search counter on every account. Invitation and message counts stay."
        confirmLabel="Reset counters"
        onConfirm={reset}
      />
    </>
  );
}

export function JobsHistory({ overview }: { overview: Pick<Overview, "runs" | "audit"> }) {
  return (
    <>
      <SettingsSection title="Recent runs" description="Slot claims and manual runs. Scheduled work is reported by each tick, which does not keep a log.">
        {overview.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <ul className={cn(RULED_LIST, "text-sm")}>
            {overview.runs.map((run) => (
              <li key={run.id} className={cn(RULED_ROW, "grid gap-0.5")}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{run.job.length > 48 ? `${run.job.slice(0, 48)}…` : run.job}</span>
                  <StatusBadge status={run.status} />
                  <Time value={run.startedAt} className="text-muted-foreground" />
                </div>
                {run.error && <p className="text-destructive">{run.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection title="Recent actions">
        {overview.audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <ul className={cn(RULED_LIST, "text-sm")}>
            {overview.audit.map((row) => (
              <li key={row.id} className={cn(RULED_ROW, "flex flex-wrap items-center gap-2")}>
                <span>{ACTION_LABEL[row.action] ?? row.action}</span>
                <span className="text-muted-foreground">
                  {row.actorName ?? "Unipile"}, <Time value={row.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </>
  );
}
