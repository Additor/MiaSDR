// Pure classification of inbound mail. No I/O, no infrastructure imports.
import { detectBounce } from "./bounce";

export interface InboundCandidate {
  from: string;
  subject: string;
  bodyText: string;
  headers: Record<string, string>;
}

const OUT_OF_OFFICE_SUBJECT = [
  /^\s*(automatic reply|auto[- ]?reply|autoreply|auto response|autoresponse)\b/i,
  /^\s*out of (the )?office\b/i,
  /\bout of (the )?office\b.*\b(auto|reply|until|return)/i,
  /^\s*(abwesenheit|automatische antwort|réponse automatique|respuesta automática|자동 ?응답|부재중)/i,
];

function header(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value.trim().toLowerCase();
  }
  return "";
}

/**
 * Machine-written replies (out of office, vacation, list robots) must not stop a sequence.
 * A bounce is handled before this check, so delivery failures are not covered here.
 */
export function isAutoReply(message: { subject: string; headers: Record<string, string> }): boolean {
  const autoSubmitted = header(message.headers, "auto-submitted");
  if (autoSubmitted !== "" && autoSubmitted !== "no") return true;
  const precedence = header(message.headers, "precedence");
  if (precedence === "bulk" || precedence === "junk" || precedence === "auto_reply") return true;
  if (header(message.headers, "x-autoreply") !== "" || header(message.headers, "x-autorespond") !== "") return true;
  return OUT_OF_OFFICE_SUBJECT.some((re) => re.test(message.subject));
}

export type InboundClass =
  | { kind: "hard_bounce"; failedRecipient: string }
  | { kind: "soft_bounce"; failedRecipient: string }
  | { kind: "own_message" }
  | { kind: "auto_reply" }
  | { kind: "message" };

/**
 * Order: bounce, own message, auto-reply, everything else.
 * Guards that `detectBounce` leaves to us: a failed recipient equal to our mailbox is not a bounce
 * we can act on, and one equal to the sender means a human wrote it (so it falls through as a reply).
 */
export function classifyInbound(mailboxAddress: string, message: InboundCandidate): InboundClass {
  const mailbox = mailboxAddress.trim().toLowerCase();
  const sender = senderAddress(message.from);

  const bounce = detectBounce(message);
  if (bounce && bounce.failedRecipient !== mailbox && bounce.failedRecipient !== sender) {
    return bounce.kind === "hard"
      ? { kind: "hard_bounce", failedRecipient: bounce.failedRecipient }
      : { kind: "soft_bounce", failedRecipient: bounce.failedRecipient };
  }
  if (sender === mailbox) return { kind: "own_message" };
  if (isAutoReply(message)) return { kind: "auto_reply" };
  return { kind: "message" };
}

function senderAddress(from: string): string {
  const angle = from.match(/<([^<>]*)>\s*$/);
  return (angle ? angle[1] : from).trim().toLowerCase();
}
