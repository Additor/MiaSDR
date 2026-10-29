import { CircleCheckIcon, CircleDashedIcon, ClockIcon, OctagonXIcon, PauseIcon, PlayIcon, ReplyIcon, type LucideIcon } from "lucide-react";
import { Time } from "@/components/shell/time";
import { stopReasonLabel } from "@/contexts/outreach/domain/campaign-view";
import { LEAD_STATE_LABELS, type LeadState, type LeadStatus } from "@/contexts/outreach/domain/lead-status";
import { cn } from "@/components/ui/utils";
import { StateTip, TipLines } from "./state-tip";

const ICONS: Record<LeadState, LucideIcon> = {
  new: CircleDashedIcon,
  queued: ClockIcon,
  in_sequence: PlayIcon,
  paused: PauseIcon,
  replied: ReplyIcon,
  finished: CircleCheckIcon,
  stopped: OctagonXIcon,
};

/** States that still wait on a send, so the next send time means something. */
const WAITING = new Set<LeadState>(["queued", "in_sequence", "paused"]);

/**
 * A lead's status as one neutral token: an icon per state and its label. Hover and keyboard focus show the campaign, the
 * steps sent, the last and next send, the stop reason and the other campaigns. The lead list and the lead page render it
 * from the same read (`readLeadStatuses`). `compact` is the list size.
 */
export function LeadStatusToken({ status, compact = false, className }: { status: LeadStatus; compact?: boolean; className?: string }) {
  const Icon = ICONS[status.state];
  const label = LEAD_STATE_LABELS[status.state];
  const classes = cn(
    "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-md border bg-background font-medium whitespace-nowrap text-foreground focus-ring [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
    compact ? "h-6 px-1.5 text-xs [&>svg]:size-3.5" : "h-7 px-2 text-sm [&>svg]:size-4",
    className,
  );
  const content = (
    <>
      <Icon aria-hidden />
      <span>{label}</span>
    </>
  );
  const lines = tipLines(status);
  if (lines.length === 0) {
    return (
      <span className={classes} data-testid="lead-status" data-state={status.state}>
        {content}
      </span>
    );
  }
  return (
    <StateTip trigger={<span tabIndex={0} className={classes} data-testid="lead-status" data-state={status.state} />} tip={<TipLines lines={lines} />}>
      {content}
    </StateTip>
  );
}

function tipLines(status: LeadStatus) {
  const { enrollment: e, otherCampaigns } = status;
  const reason = e?.stopReason ? stopReasonLabel(e.stopReason) : null;
  return [
    e && <span className="font-medium">{e.campaignName}</span>,
    e && e.step > 0 && `${e.step} ${e.step === 1 ? "step" : "steps"} sent`,
    e?.lastSentAt && (
      <>
        Last sent <Time value={e.lastSentAt} />
      </>
    ),
    e?.nextSendAt && WAITING.has(status.state) && (
      <>
        Next send <Time value={e.nextSendAt} />
      </>
    ),
    reason && reason !== LEAD_STATE_LABELS[status.state] && `Reason: ${reason}`,
    otherCampaigns > 0 && `+${otherCampaigns} other ${otherCampaigns === 1 ? "campaign" : "campaigns"}`,
  ].filter(Boolean);
}
