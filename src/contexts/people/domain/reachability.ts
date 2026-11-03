import { humanizeToken } from "@/shared/humanize";

/*
 * Reachability: which channels can reach a person, lead or contact. It is its own state and never part of the lead
 * status. Do not contact (`contact_policies`) blocks every channel. A suppressed address (`suppression_list`) always
 * blocks email, and blocks LinkedIn when the reason says the person asked to be left alone (`SUPPRESSION_BLOCKS`). A
 * bounce says only that the address is dead, so LinkedIn stays open. A channel the person has no value for is missing.
 * The people context owns both tables and writes them in `infrastructure/reachability.ts`; the contexts above decide
 * when (a stop request, a bounce, an unsubscribe) and run their own follow-through (outreach ends enrollments,
 * conversations ends runs and retires drafts). The read model there fills a page of person ids, and every list and
 * record page reads it.
 */

/** Why an address sits on the suppression list. Mirrors `suppression_reason_ck`. */
export const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "manual"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export type ReachChannel = "email" | "linkedin";

/**
 * The channels each suppression reason blocks. Enrollment, the send checks and the reach UI all read this table. A
 * complaint asks to stop harder than an unsubscribe does, so it blocks what an unsubscribe blocks.
 */
const SUPPRESSION_BLOCKS: Record<SuppressionReason, readonly ReachChannel[]> = {
  unsubscribed: ["email", "linkedin"],
  manual: ["email", "linkedin"],
  bounced: ["email"],
};

export const suppressionBlocks = (reason: string, channel: ReachChannel): boolean => (SUPPRESSION_BLOCKS[reason as SuppressionReason] ?? ["email", "linkedin"]).includes(channel);

/** The reasons that block a channel, for a SQL filter. */
export const suppressionReasonsBlocking = (channel: ReachChannel): SuppressionReason[] => SUPPRESSION_REASONS.filter((reason) => suppressionBlocks(reason, channel));

/** The form an address takes on the suppression list, and the form every lookup compares with. */
export const suppressionKey = (email: string): string => email.trim().toLowerCase();

/** The note on the suppression row a person marked do not contact leaves behind when they are deleted. */
export const DELETED_WHILE_MARKED_NOTE = "Deleted while marked do not contact.";

export interface Reachability {
  /** Null when the person is not marked do not contact. */
  doNotContact: { reason: string | null; since: Date | null } | null;
  email: { state: "open" | "suppressed" | "missing"; suppressionReason: string | null; since: Date | null };
  /** `blocked`: the person has a profile, and their address's suppression reason also closes LinkedIn. */
  linkedin: { state: "open" | "blocked" | "missing"; suppressionReason: string | null; since: Date | null };
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
  linkedin: { state: "missing", suppressionReason: null, since: null },
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
    linkedin: !facts.hasLinkedin
      ? { state: "missing", suppressionReason: null, since: null }
      : hasEmail && facts.suppression && suppressionBlocks(facts.suppression.reason, "linkedin")
        ? { state: "blocked", suppressionReason: facts.suppression.reason, since: facts.suppression.since }
        : { state: "open", suppressionReason: null, since: null },
  };
}

/** The label of each suppression reason. */
const SUPPRESSION_REASON: Record<SuppressionReason, string> = {
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  manual: "Added by hand",
};

export const suppressionReasonLabel = (reason: string): string => SUPPRESSION_REASON[reason as SuppressionReason] ?? humanizeToken(reason);
