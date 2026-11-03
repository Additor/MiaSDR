import { enrollSkipLines } from "@/contexts/outreach/domain/enrollment-eligibility";

/** Counts one enroll call returns. The add dialog sums them over its chunks and lists the reasons leads were skipped. */
export interface EnrollCounts {
  requested: number;
  added: number;
  skippedMissingIdentity: number;
  skippedDuplicate: number;
  skippedRemoved: number;
  skippedSuppressed: number;
  skippedDoNotContact: number;
  skippedStopRequest: number;
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
  skippedStopRequest: 0,
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
export const skipReasons = (counts: EnrollCounts, channel: "email" | "linkedin" | undefined): string[] => enrollSkipLines(counts, channel);
