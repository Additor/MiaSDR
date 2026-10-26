import { ArchiveIcon, CircleCheckIcon, PauseIcon, PencilLineIcon, PlayIcon, type LucideIcon } from "lucide-react";
import { campaignStatusLabel } from "@/contexts/outreach/domain/campaign-view";
import { cn } from "@/components/ui/utils";

const ICONS: Record<string, LucideIcon> = {
  draft: PencilLineIcon,
  active: PlayIcon,
  paused: PauseIcon,
  completed: CircleCheckIcon,
};

/**
 * A campaign's status as one neutral token beside its name: an icon per status and the label (Draft, Active, Paused,
 * Completed). An archived campaign reads Archived; only a completed campaign can be archived. Same form as the lead
 * status token, so the two read as one family. `compact` is the list size.
 */
export function CampaignStatusToken({ status, archived = false, compact = false, className }: { status: string; archived?: boolean; compact?: boolean; className?: string }) {
  const Icon = archived ? ArchiveIcon : (ICONS[status] ?? CircleCheckIcon);
  return (
    <span
      data-testid="campaign-status"
      data-state={archived ? "archived" : status}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-md border bg-background font-medium whitespace-nowrap text-foreground [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
        compact ? "h-6 px-1.5 text-xs [&>svg]:size-3.5" : "h-7 px-2 text-sm [&>svg]:size-4",
        className,
      )}
    >
      <Icon aria-hidden />
      <span>{archived ? "Archived" : campaignStatusLabel(status)}</span>
    </span>
  );
}
