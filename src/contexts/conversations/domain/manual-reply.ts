import { normalizeSubject } from "./subject";

/** Limits for a reply a person types by hand (INBOX-AI-001). AI drafts keep their own, smaller body cap. */
export const MANUAL_SUBJECT_MAX = 998;
export const MANUAL_BODY_MAX = 100_000;

export type ManualReplyCheck = { ok: true; subject: string; bodyText: string } | { ok: false; error: string };

/** Subject is required on email. The body is plain text, trimmed, with CRLF folded to LF. */
export function checkManualReply(input: { subject: string | null | undefined; bodyText: string }): ManualReplyCheck {
  const subject = normalizeSubject(input.subject ?? "", MANUAL_SUBJECT_MAX + 1);
  if (subject === "") return { ok: false, error: "A subject is required." };
  if (subject.length > MANUAL_SUBJECT_MAX) return { ok: false, error: `The subject is longer than ${MANUAL_SUBJECT_MAX} characters.` };
  const bodyText = input.bodyText.replace(/\r\n/g, "\n").trim();
  if (bodyText === "") return { ok: false, error: "The reply cannot be empty." };
  if (bodyText.length > MANUAL_BODY_MAX) return { ok: false, error: `The reply is longer than ${MANUAL_BODY_MAX} characters.` };
  return { ok: true, subject, bodyText };
}
