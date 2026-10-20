import { Badge } from "@/components/ui/badge";
import { humanizeToken } from "@/shared/humanize";

/**
 * The normal running states read as a quiet grey tag, waiting states as an outline, failures in red. No state gets the
 * black fill: the usual case should be the calmest thing in a row.
 */
const VARIANT: Record<string, "secondary" | "destructive" | "outline"> = {
  active: "secondary",
  connected: "secondary",
  sent: "secondary",
  completed: "secondary",
  draft: "outline",
  paused: "outline",
  pending: "outline",
  connecting: "outline",
  disabled: "outline",
  failed: "destructive",
  bounced: "destructive",
  suppressed: "secondary",
  replied: "secondary",
  cancelled: "secondary",
};

/** A stored status as a badge. `label` overrides the text; without it the token reads in sentence case ("Sent"). */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge variant={VARIANT[status] ?? "outline"}>{label ?? humanizeToken(status)}</Badge>;
}
