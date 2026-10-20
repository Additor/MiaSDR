import { randomBytes } from "node:crypto";
import type { OutgoingEmail } from "../../application/ports";

const CRLF = "\r\n";

/** A header value with a line break would let a lead's data add headers (Bcc, for one). */
function assertNoLineBreak(name: string, value: string): void {
  if (/[\r\n\u0085\u2028\u2029]/.test(value)) throw new Error(`Refusing to build the message: ${name} contains a line break.`);
}

const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

/** RFC 2047 encoded words (UTF-8, base64), cut on character boundaries so each word stays under 75 characters. */
function encodeWords(value: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char) > 42) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

function encodeSubject(subject: string): string {
  return isAscii(subject) ? subject : encodeWords(subject);
}

function formatFrom(displayName: string | null, address: string): string {
  const name = displayName?.trim();
  if (!name) return address;
  if (!isAscii(name)) return `${encodeWords(name)} <${address}>`;
  return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
}

function angle(id: string): string {
  const bare = id.trim().replace(/^<|>$/g, "");
  return `<${bare}>`;
}

function base64Lines(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return encoded.replace(/.{1,76}/g, (line) => line + CRLF).trimEnd();
}

/** Builds the RFC 5322 message Gmail's `messages.send` takes: multipart/alternative, text first, then HTML. */
/** Survives the Gmail send call; the Message-ID header does not. */
export const SEND_ID_HEADER = "X-MiaSDR-Send-Id";

export function buildMime(email: OutgoingEmail, boundary = `miasdr_${randomBytes(12).toString("hex")}`): string {
  const address = email.mailbox.emailAddress;
  const values: Array<[string, string]> = [
    ["From address", address],
    ["From name", email.mailbox.displayName ?? ""],
    ["To", email.to],
    ["Subject", email.subject],
    ["Message-ID", email.rfcMessageId],
    ["In-Reply-To", email.inReplyTo ?? ""],
    ["References", email.references.join(" ")],
    ["List-Unsubscribe", email.listUnsubscribeUrl],
  ];
  for (const [name, value] of values) assertNoLineBreak(name, value);
  for (const id of email.references) assertNoLineBreak("References", id);
  if (/[<>]/.test(email.listUnsubscribeUrl)) throw new Error("Refusing to build the message: List-Unsubscribe URL contains angle brackets.");
  const cc = email.cc ?? [];
  for (const entry of cc) assertNoLineBreak("Cc", entry);
  if (/[<>,"]/.test(address) || /[<>,"]/.test(email.to) || cc.some((entry) => /[<>,";\s]/.test(entry))) throw new Error("Refusing to build the message: an address contains characters that are not allowed.");

  const headers = [
    `From: ${formatFrom(email.mailbox.displayName, address)}`,
    `To: ${email.to}`,
    ...(cc.length > 0 ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodeSubject(email.subject)}`,
    `Message-ID: ${angle(email.rfcMessageId)}`,
    // Gmail replaces Message-ID on send, so this copy is what findSent matches on.
    `${SEND_ID_HEADER}: ${angle(email.rfcMessageId)}`,
    ...(email.inReplyTo ? [`In-Reply-To: ${angle(email.inReplyTo)}`] : []),
    ...(email.references.length > 0 ? [`References: ${email.references.map(angle).join(" ")}`] : []),
    `List-Unsubscribe: <${email.listUnsubscribeUrl}>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", base64Lines(body)].join(CRLF);

  return [headers.join(CRLF), "", part("text/plain", email.bodyText), part("text/html", email.bodyHtml), `--${boundary}--`, ""].join(CRLF);
}

export function toBase64Url(message: string): string {
  return Buffer.from(message, "utf8").toString("base64url");
}
