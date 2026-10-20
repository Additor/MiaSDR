// Plain-language text for what the enroll report and the lead panel say about people who are also in other campaigns. No I/O.

/** `campaign_enrollments.stop_reason` set by the LinkedIn claim when the same account already invited the person through another campaign. */
export const ALREADY_CONTACTED_BY_ACCOUNT = "already_contacted_by_account";

/** `campaign_enrollments.stop_reason` set when the person became a contact and their pending and active enrollments were cancelled. */
export const CONVERTED_STOP_REASON = "converted";

export const NOTICE_LIST_LIMIT = 50;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** One sentence for the top of a report, or null when there is nothing to say. */
export function noticesSummary(input: { alreadyContactedPeople: number; excludedByAccountPeople: number }): string | null {
  const parts: string[] = [];
  if (input.alreadyContactedPeople > 0) parts.push(`${plural(input.alreadyContactedPeople, "person was", "people were")} already contacted in other campaigns`);
  if (input.excludedByAccountPeople > 0) parts.push(`${plural(input.excludedByAccountPeople, "person is", "people are")} skipped because the sending account already invited them`);
  return parts.length === 0 ? null : `${parts.join(", and ")}.`.replace(/^./, (c) => c.toUpperCase());
}
