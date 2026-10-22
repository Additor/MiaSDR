import { StatusBadge } from "@/components/shell/status-badge";
import { Time } from "@/components/shell/time";
import { cn } from "@/lib/utils";
import { RULED_LIST, RULED_ROW, SettingsSection } from "../settings-section";

interface Overview {
  runs: Array<{ id: string; job: string; slot: string; status: string; organizationId: string | null; startedAt: string; finishedAt: string | null; error: string | null }>;
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

export function JobsHistory({ overview }: { overview: Overview }) {
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
