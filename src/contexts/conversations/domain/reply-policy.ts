/** Reply types that close the conversation or ask nothing of us, so no draft is made on their own. */
const NO_REPLY_REPLY_TYPES = new Set(["do_not_contact", "out_of_office", "left_company"]);

/** @deprecated The type's Reply draft rule decides (`decideReplyType`); W2, W3 and W6 remove the last callers. */
export function needsReply(groupKey: string, replyTypeKey: string): boolean {
  if (NO_REPLY_REPLY_TYPES.has(replyTypeKey)) return false;
  if (groupKey === "not_interested") return false;
  return true;
}

/** `Re: <subject>`, never `Re: Re:`. */
export function replySubject(lastSubject: string | null | undefined): string {
  const base = (lastSubject ?? "").replace(/\s+/g, " ").trim();
  if (base === "") return "Re: your message";
  return /^re:\s/i.test(base) ? base : `Re: ${base}`;
}

