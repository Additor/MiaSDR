/**
 * Wording of the contact delete row and dialog ("Contacts and Companies CRUD" in docs/decisions.md). Pure, so the
 * page, the dialog and `contact-delete-copy.test.ts` read the same lines. `name` is `contactLabel`: the full name, else the
 * email, else "this contact".
 */

export interface DeleteCounts {
  deals: { won: number; lost: number; wonTitles: string[] };
  notes: number;
  tasks: number;
  events: number;
  conversations: number;
  messages: number;
  campaigns: number;
  sends: number;
}

/** A blocker as the page and the API hand it over; `until` is an ISO timestamp. */
export type DeleteBlocker =
  | { reason: "open_deals"; deals: Array<{ id: string; title: string; stageName: string }> }
  | { reason: "send_in_flight" | "ai_job_running" | "private_conversation" | "personal_campaign_sends" }
  | { reason: "recent_send" | "recent_invite"; until: string };

export interface DeletePreview {
  person: { id: string; fullName: string | null; email: string | null; linkedinUrl: string | null; doNotContact: boolean };
  counts: DeleteCounts;
  blockers: DeleteBlocker[];
  suppressionKept: boolean;
  linkedinOnlyBlock: boolean;
  hiddenExcluded: boolean;
}

export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const CAN_DELETE = "This contact can be deleted.";
export const CANNOT_DELETE = "This contact cannot be deleted.";
export const COUNTS_INTRO = "It also deletes:";

/** The sentence of one blocker. `time` formats `until` in the organization's time zone. The open deals follow as links. */
export function blockerText(blocker: DeleteBlocker, name: string, time: (iso: string) => string): string {
  const Name = upperFirst(name);
  switch (blocker.reason) {
    case "open_deals":
      return `${Name} has ${count(blocker.deals.length, "open deal", "open deals")}. Close or delete them first.`;
    case "send_in_flight":
      return `A message to ${name} is still sending. Try again in a few minutes.`;
    case "recent_send":
      return `${Name} got a campaign email in the last 24 hours. You can delete the contact after ${time(blocker.until)}. Deleting sooner would free a send in today's mailbox limit.`;
    case "recent_invite":
      return `${Name} got a LinkedIn invitation in the last 7 days. You can delete the contact after ${time(blocker.until)}. Deleting sooner would free an invitation in this week's LinkedIn limit.`;
    case "ai_job_running":
      return `The AI is still reading a reply from ${name}. Try again in a minute.`;
    case "private_conversation":
      return `${Name} has a conversation in another member's personal campaign. An owner or admin can delete this contact.`;
    case "personal_campaign_sends":
      return `${Name} got messages in another member's personal campaign. Its creator, an owner or an admin can delete this contact.`;
  }
}

/** The dialog's count lines, in the order of 6.1. A zero line is left out; the deals line drops a zero part. */
export function countLines(counts: DeleteCounts): string[] {
  const lines: string[] = [];
  const { won, lost, wonTitles } = counts.deals;
  if (won + lost > 0) {
    const parts = [won > 0 ? count(won, "won deal", "won deals") : null, lost > 0 ? count(lost, "lost deal", "lost deals") : null].filter(Boolean);
    const titles = won > 0 && wonTitles.length > 0 ? ` Won: ${wonTitles.join(", ")}.` : "";
    lines.push(`${parts.join(" and ")}. They leave the Pipeline and its totals.${titles}`);
  }
  if (counts.notes > 0) lines.push(count(counts.notes, "note", "notes"));
  if (counts.tasks > 0) lines.push(count(counts.tasks, "task", "tasks"));
  if (counts.events > 0) lines.push(count(counts.events, "history line", "history lines"));
  if (counts.conversations > 0) lines.push(`${count(counts.conversations, "conversation", "conversations")} with ${count(counts.messages, "message", "messages")}`);
  if (counts.sends > 0) lines.push(`${count(counts.sends, "campaign send", "campaign sends")} in ${count(counts.campaigns, "campaign", "campaigns")}. Campaign reports drop them.`);
  return lines;
}

/**
 * The reach lines, one per channel (6.1). `unmarked` is the line for a contact with an email that nothing keeps blocked; the
 * dialog renders its last words, "mark them do not contact", as a button, so the line comes in two parts.
 */
export interface ReachLines {
  suppressed: string | null;
  linkedin: string | null;
  unmarked: { before: string; action: string; after: string } | null;
  bringBack: string;
}

export function reachLines(preview: Pick<DeletePreview, "person" | "suppressionKept" | "linkedinOnlyBlock">, name: string): ReachLines {
  const email = preview.person.email?.trim() || null;
  return {
    suppressed: preview.suppressionKept && email ? `${email} stays Email suppressed.` : null,
    linkedin: preview.linkedinOnlyBlock ? `After the delete, campaigns can reach ${name}'s LinkedIn profile again.` : null,
    unmarked:
      email && !preview.suppressionKept && !preview.person.doNotContact
        ? { before: `Deleting does not block ${email}. A later import can add ${name} to a campaign. To stop outreach, `, action: "mark them do not contact", after: " instead." }
        : null,
    bringBack: `A re-import, a table handoff or a new message brings ${name} back as a lead.`,
  };
}

export const deleteDescription = (name: string) => `This deletes ${name} and cannot be undone.`;
export const countsChangedText = (name: string) => `${upperFirst(name)} changed while this was open. Check the new counts and confirm again.`;
export const tryAgainText = (name: string) => `MiaSDR is saving another change to ${name}. Try again in a moment.`;
export const goneText = (name: string) => `${upperFirst(name)} no longer exists.`;
export const deletedText = (name: string) => `Deleted ${name}.`;

/** The query of `DELETE /api/contacts/[id]`: the counts the dialog showed. */
export function expectedQuery(counts: DeleteCounts): string {
  const params = new URLSearchParams({
    deals: String(counts.deals.won + counts.deals.lost),
    notes: String(counts.notes),
    tasks: String(counts.tasks),
    events: String(counts.events),
    conversations: String(counts.conversations),
    messages: String(counts.messages),
    sends: String(counts.sends),
  });
  return params.toString();
}
