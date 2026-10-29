import { cn } from "@/components/ui/utils";

/**
 * The look of a state token (`LeadStatusToken`, `CampaignStatusToken`): a neutral grey tag with a muted icon in front of
 * the label. It has no border, so it never reads as an outline button beside the header's actions. The lead token stays
 * focusable for its `StateTip`; the focus ring draws only on keyboard focus. `compact` is the list size.
 */
export function stateTokenClass(compact: boolean, className?: string): string {
  return cn(
    "inline-flex w-fit shrink-0 items-center gap-1 rounded-md bg-secondary font-medium whitespace-nowrap text-secondary-foreground focus-ring [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
    compact ? "h-5 px-1.5 text-xs [&>svg]:size-3" : "h-6 px-2 text-xs [&>svg]:size-3.5",
    className,
  );
}
