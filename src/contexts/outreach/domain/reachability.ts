import { humanizeToken } from "@/shared/humanize";

/*
 * Reachability: which channels can reach a person, lead or contact. It is its own state and never part of the lead
 * status. Do not contact (`contact_policies`, owned by conversations) blocks every channel. A suppressed address
 * (`suppression_list`, owned by outreach) blocks email only: LinkedIn stays open, as the send guards already decide. A
 * channel the person has no value for is missing. The read model (`infrastructure/drizzle-reachability.ts`) fills it for a
 * page of person ids, and every list and record page reads it there.
 */

export interface Reachability {
  /** Null when the person is not marked do not contact. */
  doNotContact: { reason: string | null; since: Date | null } | null;
  email: { state: "open" | "suppressed" | "missing"; suppressionReason: string | null; since: Date | null };
  linkedin: { state: "open" | "missing" };
}

/** The facts one person's reachability comes from. */
export interface ReachFacts {
  doNotContact: { reason: string | null; since: Date | null } | null;
  email: string | null;
  /** The address's suppression list entry, or null when it has none. */
  suppression: { reason: string; since: Date | null } | null;
  hasLinkedin: boolean;
}

/** A person with no stored facts: nothing blocks them, and they have no channel. */
export const NO_REACH: Reachability = {
  doNotContact: null,
  email: { state: "missing", suppressionReason: null, since: null },
  linkedin: { state: "missing" },
};

/**
 * One call covers a page of person ids in one query, scoped to the organization. An id of another organization or an
 * unknown id has no entry, so callers fall back to `NO_REACH`.
 */
export type ReadReachability = (organizationId: string, personIds: readonly string[]) => Promise<Map<string, Reachability>>;

export function reachability(facts: ReachFacts): Reachability {
  const hasEmail = Boolean(facts.email?.trim());
  return {
    doNotContact: facts.doNotContact,
    email: !hasEmail
      ? { state: "missing", suppressionReason: null, since: null }
      : facts.suppression
        ? { state: "suppressed", suppressionReason: facts.suppression.reason, since: facts.suppression.since }
        : { state: "open", suppressionReason: null, since: null },
    linkedin: { state: facts.hasLinkedin ? "open" : "missing" },
  };
}

/** Why an address sits on the suppression list. The stored values come from a check constraint, so the map covers all of them. */
const SUPPRESSION_REASON: Record<string, string> = {
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  manual: "Added by hand",
  complaint: "Spam complaint",
};

export const suppressionReasonLabel = (reason: string): string => SUPPRESSION_REASON[reason] ?? humanizeToken(reason);
