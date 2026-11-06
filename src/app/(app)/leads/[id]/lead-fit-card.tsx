import { Time } from "@/components/shell/time";
import { fitRoom, fitUnavailable } from "@/contexts/mia/application/mia-use-cases";
import { miaDeps } from "@/contexts/mia/infrastructure/composition";
import { FIT_SOURCE_LABELS } from "@/contexts/people/domain/lead-fit";
import { readLeadFit } from "@/read-models/lead-fit";
import type { Actor } from "@/shared/errors";
import { AsideSection } from "@/app/(app)/_components/record/record-header";
import { FitBadge } from "@/app/(app)/_components/person/fit-badge";
import { CheckLeadFit } from "../_components/check-fit";
import { FitRefresh } from "./fit-refresh";

const RESULT = { met: "met", not_met: "not met", unknown: "not known" } as const;

/**
 * Mia's latest fit verdict, each criterion with the passage behind it and where that passage came from. A person reads it
 * and decides; nothing on the lead changes with it. "Check again" shows when what the check read has changed since.
 */
export async function LeadFitCard({ actor, personId }: { actor: Actor; personId: string }) {
  const deps = miaDeps();
  const [{ fit, checking }, unavailable, room] = await Promise.all([readLeadFit(actor.organizationId, personId), fitUnavailable(deps, actor), fitRoom(deps, actor)]);
  return (
    <AsideSection title="Fit" testId="lead-fit" action={checking ? undefined : <CheckLeadFit personId={personId} unavailable={unavailable} room={room} checked={fit !== null} />}>
      {checking && (
        <p className="text-sm text-muted-foreground" role="status">
          Mia is checking this lead.
          <FitRefresh />
        </p>
      )}
      {!fit && !checking && <p className="text-sm text-muted-foreground">Not checked. Mia compares the lead with your ICP and qualification rules in Brain.</p>}
      {fit && (
        <div className="grid gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <FitBadge fit={fit} />
            <span className="text-muted-foreground">
              {fit.icpTitle ? `${fit.icpTitle}, ` : ""}
              <Time value={fit.assessedAt} dateOnly />
            </span>
          </div>
          {fit.criteria.length > 0 && (
            <ul className="grid gap-2" aria-label="Criteria">
              {fit.criteria.map((c, i) => (
                <li key={i} className="grid gap-0.5" data-testid="fit-criterion">
                  <span>
                    <span className="font-medium">{c.criterion}</span>
                    {c.type === "disqualifier" && <span className="text-muted-foreground"> (a reason to leave out)</span>}: {RESULT[c.result]}
                  </span>
                  {c.evidence && c.source && (
                    <span className="text-muted-foreground">
                      {FIT_SOURCE_LABELS[c.source]}: &ldquo;{c.evidence}&rdquo;
                    </span>
                  )}
                  {c.unsupported && <span className="text-muted-foreground">Mia named a passage the source does not hold, so this counts as not known.</span>}
                </li>
              ))}
            </ul>
          )}
          {fit.missing.length > 0 && <p className="text-muted-foreground">Still unknown: {fit.missing.join(", ")}.</p>}
        </div>
      )}
    </AsideSection>
  );
}
