// Pure bounce detection for inbound mail. No I/O, no infrastructure imports.

export interface BounceCandidate {
  from: string;
  subject: string;
  bodyText: string;
  headers?: Record<string, string>;
}

export interface BounceResult {
  failedRecipient: string;
  kind: "hard" | "soft";
}

const DELIVERY_SYSTEM_LOCAL_PARTS = new Set(["mailer-daemon", "postmaster"]);
const DELIVERY_SYSTEM_DISPLAY_NAME = /mail delivery (subsystem|system)/i;

const FAILURE_SUBJECT_PATTERNS: RegExp[] = [
  /^\s*undeliverable/i,
  /^\s*returned mail/i,
  /delivery status notification \(failure\)/i,
  /delivery (has failed|failure)/i,
  /mail delivery (failed|subsystem)/i,
];

const DELAY_SUBJECT = /\(delay\)/i;

// Capture group 1 holds the raw address candidate. Order is the priority order.
const EMAIL = String.raw`<?([^\s<>"'(),;:]+@[^\s<>"'(),;:]+)>?`;
const RECIPIENT_PATTERNS: RegExp[] = [
  // Gmail: "Your message wasn't delivered to x@y.com because ..."
  new RegExp(String.raw`wasn['’]t delivered to\s+${EMAIL}`, "i"),
  // Gmail: "There was a problem delivering your message to x@y.com"
  new RegExp(String.raw`problem delivering your message to\s+${EMAIL}`, "i"),
  // "Your message to x@y.com couldn't be delivered" or "has been blocked"
  new RegExp(
    String.raw`your message to\s+${EMAIL}\s+(?:couldn['’]t be delivered|has been blocked)`,
    "i",
  ),
  // Microsoft: "Recipient Address: x@y.com"
  new RegExp(String.raw`recipient address:\s*${EMAIL}`, "i"),
  // Gmail list template: "** Address not found ** ... address(es) failed:\n x@y.com"
  new RegExp(String.raw`address(?:\(es\)|es)? failed:\s*${EMAIL}`, "i"),
  // GoDaddy: "The following recipients failed permanently: x@y.com"
  new RegExp(String.raw`recipients failed permanently:\s*${EMAIL}`, "i"),
  // RFC 3464: "Final-Recipient: rfc822; x@y.com"
  new RegExp(String.raw`final-recipient:\s*rfc822;\s*${EMAIL}`, "i"),
];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

const SOFT_PATTERNS: RegExp[] = [
  /(?<![\d.])4\.\d{1,3}\.\d{1,3}(?![\d.])/,
  /mailbox (?:is )?full/i,
  /over quota/i,
  /temporar(?:y|ily)/i,
  /try again later/i,
];

function getHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string {
  if (!headers) return "";
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return "";
}

function parseSender(from: string): { name: string; localPart: string } {
  const angle = from.match(/^(.*)<([^<>]*)>\s*$/);
  const address = (angle ? angle[2] : from).trim().toLowerCase();
  const name = angle ? angle[1].replace(/["']/g, "").trim() : "";
  const at = address.lastIndexOf("@");
  return { name, localPart: at === -1 ? address : address.slice(0, at) };
}

function isDeliverySystemSender(from: string): boolean {
  const { name, localPart } = parseSender(from);
  return (
    DELIVERY_SYSTEM_LOCAL_PARTS.has(localPart) ||
    DELIVERY_SYSTEM_DISPLAY_NAME.test(name)
  );
}

function isFailureSubject(subject: string): boolean {
  return FAILURE_SUBJECT_PATTERNS.some((re) => re.test(subject));
}

function hasBounceHeaders(
  headers: Record<string, string> | undefined,
  subject: string,
): boolean {
  const contentType = getHeader(headers, "content-type").toLowerCase();
  if (
    contentType.includes("multipart/report") &&
    contentType.includes("delivery-status")
  ) {
    return true;
  }
  const autoSubmitted = getHeader(headers, "auto-submitted").toLowerCase();
  const automated =
    autoSubmitted.includes("auto-replied") ||
    autoSubmitted.includes("auto-generated");
  return automated && isFailureSubject(subject);
}

function extractRecipient(bodyText: string): string | null {
  for (const pattern of RECIPIENT_PATTERNS) {
    const match = pattern.exec(bodyText);
    if (!match) continue;
    const address = match[1].trim().toLowerCase().replace(/[.,]+$/, "");
    if (EMAIL_SHAPE.test(address)) return address;
  }
  return null;
}

function classify(bodyText: string): "hard" | "soft" {
  return SOFT_PATTERNS.some((re) => re.test(bodyText)) ? "soft" : "hard";
}

export function detectBounce(message: BounceCandidate): BounceResult | null {
  // A delay notice means delivery may still succeed, so it is not a bounce.
  if (DELAY_SUBJECT.test(message.subject)) return null;

  const fromDeliverySystem = isDeliverySystemSender(message.from);
  if (!fromDeliverySystem && !hasBounceHeaders(message.headers, message.subject)) {
    return null;
  }

  const failedRecipient = extractRecipient(message.bodyText);
  if (!failedRecipient) return null;

  return { failedRecipient, kind: classify(message.bodyText) };
}

/** Mail systems whose delivery notices we accept without a tie to one of our sends. */
const TRUSTED_NOTICE_DOMAINS = ["googlemail.com", "google.com", "gmail.com"];

function addressParts(from: string): { localPart: string; domain: string } {
  const angle = from.match(/<([^<>]*)>\s*$/);
  const address = (angle ? angle[1] : from).trim().toLowerCase();
  const at = address.lastIndexOf("@");
  return at === -1 ? { localPart: address, domain: "" } : { localPart: address.slice(0, at), domain: address.slice(at + 1) };
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase();
}

const isSameOrSubdomain = (domain: string, parent: string) => parent !== "" && (domain === parent || domain.endsWith(`.${parent}`));

/**
 * True when the sender address (never the display name, which anyone can set) is a delivery-system
 * mailbox (mailer-daemon, postmaster) on a domain that can plausibly report on this send: a Google
 * mail domain, our own mailbox domain, or the failed recipient's domain.
 */
export function isGenuineDeliverySender(from: string, mailboxAddress: string, failedRecipient: string): boolean {
  const { localPart, domain } = addressParts(from);
  if (!DELIVERY_SYSTEM_LOCAL_PARTS.has(localPart) || domain === "") return false;
  return (
    TRUSTED_NOTICE_DOMAINS.includes(domain) ||
    isSameOrSubdomain(domain, domainOf(mailboxAddress)) ||
    isSameOrSubdomain(domain, domainOf(failedRecipient))
  );
}

/** Gmail writes its own results under an authserv-id on google.com (mx.google.com). */
const TRUSTED_AUTHSERV = /(^|\.)google\.com$/;

interface AuthMethodResult {
  method: string;
  result: string;
  props: Map<string, string>;
}

const stripComments = (value: string) => value.replace(/\([^()]*\)/g, " ");
const bareDomain = (value: string) => value.trim().replace(/^.*@/, "").replace(/[>;\s]+$/, "").toLowerCase();

/**
 * Parses one Authentication-Results value (RFC 8601) into its authserv-id and method results.
 * Returns null unless the authserv-id is a Google host, because only Gmail's own header is evidence.
 * Parsing is conservative: only the single value it is given is read (the caller passes the first,
 * top header, which the receiving Gmail adds above anything the sender injected), comments are
 * dropped, and anything that does not match the grammar is ignored.
 */
export function parseAuthenticationResults(value: string): { authservId: string; results: AuthMethodResult[] } | null {
  const [head, ...rest] = stripComments(value).split(";");
  const authservId = (head ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!authservId || !TRUSTED_AUTHSERV.test(authservId)) return null;
  const results: AuthMethodResult[] = [];
  for (const segment of rest) {
    const m = /^\s*([a-z0-9-]+)\s*=\s*([a-z]+)\b([\s\S]*)$/i.exec(segment);
    if (!m) continue;
    const props = new Map<string, string>();
    for (const p of m[3].matchAll(/([a-z]+\.[a-z-]+)\s*=\s*([^\s;]+)/gi)) props.set(p[1].toLowerCase(), p[2].replace(/^"|"$/g, ""));
    results.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props });
  }
  return { authservId, results };
}

const aligned = (a: string, b: string) => a !== "" && b !== "" && a.includes(".") && b.includes(".") && (isSameOrSubdomain(a, b) || isSameOrSubdomain(b, a));

/**
 * True when Gmail's Authentication-Results shows the message really came from `domain`:
 * dmarc=pass for header.from equal to the domain, or dkim=pass signed by an aligned domain, or
 * spf=pass for an aligned envelope domain. Any dmarc=fail/temperror/permerror rejects outright.
 */
export function isAuthenticatedFrom(authenticationResults: string | undefined, domain: string): boolean {
  if (!authenticationResults || domain === "") return false;
  const parsed = parseAuthenticationResults(authenticationResults);
  if (!parsed) return false;
  const dmarc = parsed.results.filter((r) => r.method === "dmarc");
  if (dmarc.some((r) => r.result !== "pass")) return false;
  return parsed.results.some((r) => {
    if (r.result !== "pass") return false;
    if (r.method === "dmarc") return bareDomain(r.props.get("header.from") ?? "") === domain;
    if (r.method === "dkim") return aligned(bareDomain(r.props.get("header.d") ?? r.props.get("header.i") ?? ""), domain);
    if (r.method === "spf") return aligned(bareDomain(r.props.get("smtp.mailfrom") ?? ""), domain);
    return false;
  });
}

export interface BounceEvidence {
  from: string;
  mailboxAddress: string;
  failedRecipient: string;
  /** We sent mail to the failed recipient from this mailbox within the retention horizon. */
  weSentToRecipient: boolean;
  /** The message carries our send id or answers a Message-ID of ours, and that send went to the failed recipient. */
  tiedToOurSend: boolean;
  /** Raw value of the first (top) Authentication-Results header Gmail added, when present. */
  authenticationResults?: string;
}

/**
 * A bounce may suppress an address only when we mailed that address from this mailbox AND either the
 * message is tied to that send (our send id or a Message-ID reference, which is its own proof) or it
 * comes from a delivery-system sender whose domain Gmail authenticated (DMARC, DKIM or SPF pass for
 * the claimed sender domain). Anything else is an ordinary message.
 */
export function isVerifiedBounce(evidence: BounceEvidence): boolean {
  if (!evidence.weSentToRecipient) return false;
  if (evidence.tiedToOurSend) return true;
  if (!isGenuineDeliverySender(evidence.from, evidence.mailboxAddress, evidence.failedRecipient)) return false;
  return isAuthenticatedFrom(evidence.authenticationResults, addressParts(evidence.from).domain);
}
