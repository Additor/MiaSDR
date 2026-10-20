/**
 * The items of a member picker (the task assignee, the deal owner). A value outside the member list, such as a user who left
 * the organization, gets the item "Former member", so the Select never shows the raw user id.
 */

export interface MemberChoice {
  userId: string;
  name: string;
}

export interface MemberItem {
  value: string;
  label: string;
}

export const FORMER_MEMBER = "Former member";

/**
 * The members, the current user marked "(you)", then "Former member" for `value` when no member holds it. `none` is the
 * empty choice ("Unassigned" first, or "No owner" last) and its value never counts as a former member.
 */
export function memberItems(
  members: readonly MemberChoice[],
  currentUserId: string,
  value: string | null | undefined,
  none: { value: string; label: string; at: "start" | "end" },
): MemberItem[] {
  const people = members.map((m) => ({ value: m.userId, label: m.userId === currentUserId ? `${m.name} (you)` : m.name }));
  const former = value && value !== none.value && !members.some((m) => m.userId === value) ? [{ value, label: FORMER_MEMBER }] : [];
  const empty = { value: none.value, label: none.label };
  return none.at === "start" ? [empty, ...people, ...former] : [...people, ...former, empty];
}
