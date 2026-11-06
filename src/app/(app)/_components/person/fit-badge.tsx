import { Badge } from "@/components/ui/badge";
import { FIT_VERDICT_LABELS, type FitVerdict } from "@/contexts/people/domain/lead-fit";

/** A fit reads as a quiet grey tag and the others as an outline: a verdict is a hint for a person, never an alarm. */
const VARIANT: Record<FitVerdict, "secondary" | "outline"> = { fit: "secondary", partial: "outline", not_fit: "outline", unknown: "outline" };

/** Mia's verdict on a lead, with a note when what it read has changed since. */
export function FitBadge({ fit }: { fit: { verdict: FitVerdict; changed: boolean } }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="fit-badge">
      <Badge variant={VARIANT[fit.verdict]}>{FIT_VERDICT_LABELS[fit.verdict]}</Badge>
      {fit.changed && <span className="text-xs text-muted-foreground">Check again</span>}
    </span>
  );
}
