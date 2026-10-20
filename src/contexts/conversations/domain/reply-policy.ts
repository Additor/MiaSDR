/** Subcategories that close the conversation or ask nothing of us, so no draft is made on their own. */
const NO_REPLY_SUBCATEGORIES = new Set(["do_not_contact", "out_of_office", "left_company"]);

/** Whether an applied classification calls for a reply draft. A person can still ask for one on any thread. */
export function needsReply(categoryKey: string, subcategoryKey: string): boolean {
  if (NO_REPLY_SUBCATEGORIES.has(subcategoryKey)) return false;
  if (categoryKey === "not_interested") return false;
  return true;
}

/** `Re: <subject>`, never `Re: Re:`. */
export function replySubject(lastSubject: string | null | undefined): string {
  const base = (lastSubject ?? "").replace(/\s+/g, " ").trim();
  if (base === "") return "Re: your message";
  return /^re:\s/i.test(base) ? base : `Re: ${base}`;
}

export const DRAFT_OPEN_STATUSES = ["generating", "awaiting_review", "sending", "delivery_uncertain"] as const;
