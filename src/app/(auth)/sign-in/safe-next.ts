/** Where sign-in lands, read from `?next=`. Only same-site paths pass: a crafted link must not send you elsewhere. */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/leads";
  // A backslash reads as a slash in some browsers, and the URL parser drops tabs and newlines, so "/\t/x" becomes "//x".
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return "/leads";
  return next;
}
