import { BanIcon, TriangleAlertIcon } from "lucide-react";
import { Time, useOrgTimeZone } from "@/components/shell/time";
import { Badge } from "@/components/ui/badge";
import type { SearchCapacityView } from "@/contexts/outreach/linkedin/application/linkedin-search-capacity";
import { capacityNote, type CapacityTier } from "@/contexts/outreach/linkedin/domain/linkedin-search-capacity";
import { capacityReturnText } from "./capacity-return";

const TIER: Record<CapacityTier, string> = { green: "Plenty left", yellow: "Running low", red: "Almost out" };

/**
 * Plenty left reads in plain text. Near the limit takes the warning hue on its icon, and red marks only an account that
 * cannot search now (none left, or restricted by LinkedIn).
 */
function TierIcon({ tier, blocked }: { tier: CapacityTier; blocked: boolean }) {
  if (blocked) return <BanIcon aria-hidden className="text-destructive" />;
  if (tier === "green") return null;
  return <TriangleAlertIcon aria-hidden className="text-warning" />;
}

/** Dates arrive as ISO strings after crossing to a client component, and as Dates on a server page. */
type Dated<T> = { [K in keyof T]: T[K] extends Date | null ? string | Date | null : T[K] };
export type CapacityCardData = Dated<Omit<SearchCapacityView, "accounts">> & { accounts: Array<Dated<SearchCapacityView["accounts"][number]>> };

const asDate = (value: string | Date | null) => (value === null ? null : new Date(value));

/**
 * "Search capacity today": per account, how many of its daily search results remain, with a green, yellow or red tier.
 * Every time prints in the organization's zone, the daily reset included. The count itself restarts at 00:00 UTC, which
 * the reset time already states.
 */
export function SearchCapacityCard({ capacity }: { capacity: CapacityCardData }) {
  const timeZone = useOrgTimeZone();
  if (capacity.accounts.length === 0) return null;
  const resetsAt = capacityReturnText(capacity.dayResetsAt, timeZone);
  const nextReturn = asDate(capacity.nextReturnAt);
  return (
    <section data-testid="search-capacity" className="stack-group">
      <div className="stack-field">
        <h2 className="text-sm font-semibold">Search capacity today</h2>
        <p className="text-sm text-muted-foreground">
          Each account can read a limited number of people per day. {resetsAt ? `The count restarts at ${resetsAt}.` : null}
          {nextReturn ? (
            <>
              {" "}
              No account can search now.
              {nextReturn.getTime() !== asDate(capacity.dayResetsAt)?.getTime() && (
                <>
                  {" "}
                  The first one can search again at <Time value={nextReturn} />.
                </>
              )}
            </>
          ) : null}
        </p>
      </div>
      <div className="divide-y">
        {capacity.accounts.map((a) => {
          const restrictedUntil = asDate(a.restrictedUntil);
          const returnsAt = asDate(a.returnsAt);
          const note = capacityNote({ tier: a.tier, left: a.left, restricted: restrictedUntil !== null, resetsAt });
          return (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm first:pt-0 last:pb-0" data-testid="search-capacity-account" data-tier={a.tier}>
              <span className="font-medium">{a.name}</span>
              <span className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-muted-foreground">
                  {a.left.toLocaleString("en-US")} of {a.limit.toLocaleString("en-US")} left
                </span>
                <Badge variant="outline">
                  <TierIcon tier={a.tier} blocked={a.left === 0 || restrictedUntil !== null} />
                  {TIER[a.tier]}
                </Badge>
                {restrictedUntil && <span className="text-xs text-muted-foreground">LinkedIn restricted this account until <Time value={restrictedUntil} /></span>}
                {returnsAt && restrictedUntil && returnsAt.getTime() > restrictedUntil.getTime() && <span className="text-xs text-muted-foreground">Can search again at <Time value={returnsAt} /></span>}
                {note && <span className="text-xs text-muted-foreground">{note}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
