import { ArchiveIcon, CircleCheckIcon, PauseIcon, PencilLineIcon, PlayIcon, type LucideIcon } from "lucide-react";
import { campaignStatusLabel } from "@/contexts/outreach/domain/campaign-view";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  draft: PencilLineIcon,
  active: PlayIcon,
  paused: PauseIcon,
  completed: CircleCheckIcon,
};

/**
 * A campaign's status as one neutral token beside its name: an icon per status and the label (Draft, Active, Paused,
 * Completed). An archived campaign reads Archived; only a completed campaign can be archived. Same form as the lead
 * status token, so the two read as one family.
 */
export function CampaignStatusToken({ status, archived = false, className }: { status: string; archived?: boolean; className?: string }) {
  const Icon = archived ? ArchiveIcon : (ICONS[status] ?? CircleCheckIcon);
  return (
    <span
      data-testid="campaign-status"
      data-state={archived ? "archived" : status}
      className={cn(
        "inline-flex h-7 w-fit shrink-0 items-center gap-1.5 rounded-md border bg-background px-2 text-sm font-medium whitespace-nowrap text-foreground [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
        className,
      )}
    >
      <Icon aria-hidden />
      <span>{archived ? "Archived" : campaignStatusLabel(status)}</span>
    </span>
  );
}
