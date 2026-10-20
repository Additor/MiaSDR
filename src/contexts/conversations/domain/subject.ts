/** Collapses whitespace in a subject, including CR, LF, NEL (U+0085), U+2028 and U+2029, which JS `\s` partly misses. */
export const MAX_SUBJECT_CHARS = 200;

export function normalizeSubject(subject: string, max = MAX_SUBJECT_CHARS): string {
  const collapsed = subject.replace(/[\s\u0085\u2028\u2029\p{Cc}]+/gu, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max).trim() : collapsed;
}
