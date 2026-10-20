import { elapsed } from "@/shared/format-time";

export type WaitingBasis = "inbound" | "failure" | "due";

/**
 * What a queue row says about its clock. A reply waits since the person wrote, a follow-up is overdue since its due time,
 * a problem failed at some point. `elapsed` carries the unit, so a row reads "Waiting 2 d" and the headline reads "2 days".
 */
export function waitingLabel(waiting: { at: Date | string; basis: WaitingBasis }, now: Date | string): string {
  const since = elapsed(waiting.at, now);
  if (since === "") return "";
  switch (waiting.basis) {
    case "inbound":
      return `Waiting ${since}`;
    case "due":
      return `Overdue ${since}`;
    case "failure":
      return since === "under a minute" ? "Failed just now" : `Failed ${since} ago`;
  }
}
