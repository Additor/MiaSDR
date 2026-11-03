/*
 * May this person enter this campaign? `enrollBlockSql` (`infrastructure/enrollment-eligibility.ts`) answers with one of
 * these blocks or null, and every enroll path reads that one answer: the search and picked forms of both channels, their
 * dry runs, the MCP tool, the Tables handoff and the LinkedIn search sink. So a preview and the enroll it previews count the
 * same people in the same buckets. A restore reads the same suppression fragment. docs/decisions.md, "Enroll, remove, restore", lists what stays outside this rule.
 */

type Channel = "email" | "linkedin";

/** Why a person cannot be enrolled. The order is the precedence: the first that holds is the one a person is counted under. */
export const ENROLL_BLOCKS = ["missing_identity", "removed", "duplicate", "suppressed", "do_not_contact", "stop_request", "contact"] as const;
export type EnrollBlock = (typeof ENROLL_BLOCKS)[number];

/** The skip buckets of an enroll answer. Every person a call looked at and did not add lands in exactly one. */
export interface EnrollSkipCounts {
  /** No email (email campaign) or no LinkedIn profile (LinkedIn campaign). */
  skippedMissingIdentity: number;
  /** Removed earlier from this campaign. Enrolling does not bring them back; a restore does. */
  skippedRemoved: number;
  /** Already enrolled and not removed. */
  skippedDuplicate: number;
  /** An address on the suppression list, for a reason that blocks this channel (`suppressionBlocks`). */
  skippedSuppressed: number;
  skippedDoNotContact: number;
  /** The latest reply reads as a request to stop and no person reviewed it. */
  skippedStopRequest: number;
  /** The person is a contact (a deal exists or was created from the lead), and a contact is not enrolled in campaigns. */
  skippedContact: number;
}

/** What a skip reads as: a sentence for one row of a handoff, and the words after a count in an enroll summary. */
interface BlockReason {
  bucket: keyof EnrollSkipCounts;
  row: (channel: Channel) => string;
  one: (channel: Channel) => string;
  many: (channel: Channel) => string;
}

const same = (text: string) => () => text;
const removedLine = same("removed earlier from this campaign; restore them from the campaign page");
const noIdentity = (channel: Channel) => (channel === "linkedin" ? "without a LinkedIn URL" : "without an email");

/** The one reason table: each block's bucket and wording. */
export const ENROLL_BLOCK_REASONS: Record<EnrollBlock, BlockReason> = {
  missing_identity: {
    bucket: "skippedMissingIdentity",
    row: (channel) => (channel === "linkedin" ? "The matching lead has no LinkedIn profile" : "The matching lead has no email"),
    one: noIdentity,
    many: noIdentity,
  },
  removed: { bucket: "skippedRemoved", row: same("Person was removed from this campaign earlier. Restore them from the campaign page"), one: removedLine, many: removedLine },
  duplicate: { bucket: "skippedDuplicate", row: same("Person is already in this campaign"), one: same("already in the campaign"), many: same("already in the campaign") },
  suppressed: { bucket: "skippedSuppressed", row: same("Email is suppressed"), one: same("on the suppression list"), many: same("on the suppression list") },
  do_not_contact: { bucket: "skippedDoNotContact", row: same("Person is marked do not contact"), one: same("marked do not contact"), many: same("marked do not contact") },
  stop_request: {
    bucket: "skippedStopRequest",
    row: same("The latest reply seems to ask to stop. Review it in Actions"),
    one: same("seems to ask to stop; review it in Actions"),
    many: same("seem to ask to stop; review them in Actions"),
  },
  contact: { bucket: "skippedContact", row: same("Is a contact"), one: same("is a contact"), many: same("are contacts") },
};

export const NO_ENROLL_SKIPS: EnrollSkipCounts = { skippedMissingIdentity: 0, skippedRemoved: 0, skippedDuplicate: 0, skippedSuppressed: 0, skippedDoNotContact: 0, skippedStopRequest: 0, skippedContact: 0 };

/** The buckets of `enrollBlockSql` rows, with how many had no block. */
export function countEnrollBlocks(rows: Iterable<{ block: EnrollBlock | null; n: number }>): { skips: EnrollSkipCounts; eligible: number; total: number } {
  const skips = { ...NO_ENROLL_SKIPS };
  let eligible = 0;
  let total = 0;
  for (const { block, n } of rows) {
    total += n;
    if (block === null) eligible += n;
    else skips[ENROLL_BLOCK_REASONS[block].bucket] += n;
  }
  return { skips, eligible, total };
}

/** One line per skip reason with a nonzero count, in order of precedence. An id the organization does not know comes last. */
export function enrollSkipLines(counts: Partial<EnrollSkipCounts> & { skippedNotFound?: number }, channel: Channel = "email"): string[] {
  const lines = ENROLL_BLOCKS.flatMap((block) => {
    const reason = ENROLL_BLOCK_REASONS[block];
    const n = counts[reason.bucket] ?? 0;
    return n > 0 ? [`${n} ${n === 1 ? reason.one(channel) : reason.many(channel)}`] : [];
  });
  return counts.skippedNotFound ? [...lines, `${counts.skippedNotFound} no longer exist`] : lines;
}
