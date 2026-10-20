/** Counts one enroll call returns. The add dialog sums them over its chunks and lists the reasons leads were skipped. */
export interface EnrollCounts {
  requested: number;
  added: number;
  skippedMissingIdentity: number;
  skippedDuplicate: number;
  skippedRemoved: number;
  skippedSuppressed: number;
  skippedDoNotContact: number;
  skippedContact: number;
  skippedNotFound: number;
}

export const ZERO_COUNTS: EnrollCounts = {
  requested: 0,
  added: 0,
  skippedMissingIdentity: 0,
  skippedDuplicate: 0,
  skippedRemoved: 0,
  skippedSuppressed: 0,
  skippedDoNotContact: 0,
  skippedContact: 0,
  skippedNotFound: 0,
};

/** Adds one chunk's counts to the running total. A count the server leaves out adds nothing. */
export function addCounts(total: EnrollCounts, part: Partial<EnrollCounts>): EnrollCounts {
  const next = { ...total };
  for (const key of Object.keys(next) as Array<keyof EnrollCounts>) next[key] += part[key] ?? 0;
  return next;
}

/** One line per skip reason with a nonzero count, in the order the dialog lists them. */
export function skipReasons(counts: EnrollCounts, channel: "email" | "linkedin" | undefined): string[] {
  const identity = channel === "linkedin" ? "without a LinkedIn URL" : "without an email";
  const lines: Array<[number, string]> = [
    [counts.skippedDuplicate, "already in the campaign"],
    [counts.skippedRemoved, "removed earlier from this campaign; restore them from the campaign page"],
    [counts.skippedMissingIdentity, identity],
    [counts.skippedSuppressed, "unsubscribed"],
    [counts.skippedDoNotContact, "marked do not contact"],
    [counts.skippedContact, counts.skippedContact === 1 ? "is a contact" : "are contacts"],
    [counts.skippedNotFound, "no longer exist"],
  ];
  return lines.filter(([n]) => n > 0).map(([n, text]) => `${n} ${text}`);
}
