/** Lines a mail client quoted from an earlier message, and everything after an "On ... wrote:" marker. */
export function stripQuoted(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*On .{5,200} wrote:\s*$/.test(line) || /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

const PATTERNS = [
  /\bunsubscribe\b/i,
  /\bremove (me|us|my (e-?mail|address))\b/i,
  /\btake (me|us) off\b/i,
  /\bdo not (contact|email|e-mail) (me|us)\b/i,
  /\bdon'?t (contact|email|e-mail) (me|us)\b/i,
  /\bstop (emailing|e-mailing|contacting|sending|messaging)\b/i,
  /\bno more (e-?mails?|messages)\b/i,
  /\bopt[ -]?out\b/i,
];

/** True when the sender's own words ask us to stop. It only raises a flag for a person; nothing is suppressed from here. */
export function detectsStopRequest(body: string): boolean {
  const own = stripQuoted(body);
  return PATTERNS.some((p) => p.test(own));
}
