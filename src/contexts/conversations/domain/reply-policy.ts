/** `Re: <subject>`, never `Re: Re:`. */
export function replySubject(lastSubject: string | null | undefined): string {
  const base = (lastSubject ?? "").replace(/\s+/g, " ").trim();
  if (base === "") return "Re: your message";
  return /^re:\s/i.test(base) ? base : `Re: ${base}`;
}

