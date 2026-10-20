export interface PriorSend {
  subject: string | null;
  rfcMessageId: string | null;
  threadId: string | null;
}

export interface Threading {
  subject: string;
  inReplyTo: string | null;
  references: string[];
  threadId: string | null;
}

/**
 * A step with its own subject starts a new message. A step with a blank
 * subject replies in the thread of the latest earlier send that had one:
 * `Re: <subject>` (never `Re: Re:`), In-Reply-To the latest, References all
 * earlier Message-IDs oldest first. `priorSent` is ordered oldest first.
 */
export function resolveThreading(renderedSubject: string, priorSent: PriorSend[]): Threading {
  if (renderedSubject.trim() !== "") {
    return { subject: renderedSubject, inReplyTo: null, references: [], threadId: null };
  }
  const anchor = [...priorSent].reverse().find((s) => (s.subject ?? "").trim() !== "");
  if (!anchor) return { subject: "", inReplyTo: null, references: [], threadId: null };
  const base = (anchor.subject ?? "").trim();
  return {
    subject: /^re:\s/i.test(base) ? base : `Re: ${base}`,
    inReplyTo: anchor.rfcMessageId,
    references: priorSent.map((s) => s.rfcMessageId).filter((id): id is string => Boolean(id)),
    threadId: anchor.threadId,
  };
}
