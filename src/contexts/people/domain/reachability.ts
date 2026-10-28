import { humanizeToken } from "@/shared/humanize";

/*
 * Reachability: which channels can reach a person, lead or contact. It is its own state and never part of the lead
 * status. Do not contact (`contact_policies`) blocks every channel. A suppressed address (`suppression_list`) blocks
 * email only: LinkedIn stays open, as the send guards already decide. A channel the person has no value for is missing.
 * The people context owns both tables and writes them in `infrastructure/reachability.ts`; the contexts above decide
 * when (a stop request, a bounce, an unsubscribe) and run their own follow-through (outreach ends enrollments,
 * conversations ends runs and retires drafts). The read model there fills a page of person ids, and every list and
 * record page reads it.
 */

/** Why an address sits on the suppression list. Mirrors `suppression_reason_ck`. */
export const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "manual", "complaint"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** The form an address takes on the suppression list, and the form every lookup compares with. */
export const suppressionKey = (email: string): string => email.trim().toLowerCase();

/** The note on the suppression row a person marked do not contact leaves behind when they are deleted. */
export const DELETED_WHILE_MARKED_NOTE = "Deleted while marked do not contact.";

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

/** The label of each suppression reason. */
const SUPPRESSION_REASON: Record<SuppressionReason, string> = {
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  manual: "Added by hand",
  complaint: "Spam complaint",
};

export const suppressionReasonLabel = (reason: string): string => SUPPRESSION_REASON[reason as SuppressionReason] ?? humanizeToken(reason);
