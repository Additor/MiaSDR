import type { InboundEmail } from "../../application/ports";
import { dedupeAddresses, parseAddressList } from "../../domain/address-list";

/** The slice of a Gmail API `users.messages` resource (format=full) that parsing reads. */
export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

const BODY_CAP = 200_000;
const KEPT_HEADERS = ["content-type", "auto-submitted", "x-failed-recipients", "precedence", "list-id", "return-path", "x-miasdr-send-id"];
const SEND_ID = "x-miasdr-send-id";
/** Raw sender-authentication headers, kept for the bounce check. Gmail's own verdict is the first value; later ones can be forged upstream. */
const AUTH_HEADERS = ["authentication-results", "received-spf"];
const AUTH_HEADER_CAP = 2000;

/** Turns one full-format Gmail message into the provider-neutral shape. Pure: no I/O. */
export function parseGmailMessage(message: GmailMessage): InboundEmail {
  const payload = message.payload ?? {};
  const all = headerMap(payload.headers);
  const from = parseAddress(all.get("from") ?? "");

  const headers: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = all.get(name);
    if (value !== undefined) headers[name] = value;
  }

  for (const name of AUTH_HEADERS) {
    const value = all.get(name)?.trim();
    if (value) headers[name] = value.slice(0, AUTH_HEADER_CAP);
  }

  const sendId = stripAngles(all.get(SEND_ID)) ?? findNestedSendId(payload);

  return {
    providerMessageId: message.id,
    threadId: message.threadId ?? null,
    rfcMessageId: all.get("message-id")?.trim() || null,
    inReplyTo: all.get("in-reply-to")?.trim() || null,
    references: (all.get("references") ?? "").split(/\s+/).filter(Boolean),
    from,
    to: parseAddressList(all.get("to")).map((a) => a.email),
    cc: dedupeAddresses(
      [...headerValues(payload.headers, "cc"), ...headerValues(payload.headers, "resent-cc")].flatMap((v) => parseAddressList(v)),
    ).map((a) => a.email),
    subject: decodeEncodedWords(all.get("subject") ?? "").trim(),
    bodyText: extractBody(payload).slice(0, BODY_CAP),
    receivedAt: parseDate(all.get("date"), message.internalDate),
    headers,
    sendId,
  };
}

function headerMap(headers: GmailPart["headers"]): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of headers ?? []) {
    if (!h.name || h.value === undefined) continue;
    const key = h.name.toLowerCase();
    if (!map.has(key)) map.set(key, h.value);
  }
  return map;
}

/** Every value of a header that may repeat (Resent-Cc appears once per resend). */
function headerValues(headers: GmailPart["headers"], name: string): string[] {
  return (headers ?? []).filter((h) => h.name?.toLowerCase() === name && h.value).map((h) => h.value!);
}

function stripAngles(value: string | undefined): string | null {
  const v = value?.trim().replace(/^<|>$/g, "").trim();
  return v ? v : null;
}

function parseDate(header: string | undefined, internalDate: string | undefined): Date {
  if (header) {
    const d = new Date(header);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const ms = Number(internalDate);
  return Number.isFinite(ms) && internalDate ? new Date(ms) : new Date(0);
}

function parseAddress(raw: string): { email: string; name: string | null } {
  const text = raw.trim();
  const angle = /<([^<>]*)>\s*$/.exec(text);
  if (angle) {
    const name = decodeEncodedWords(text.slice(0, angle.index).trim().replace(/^"|"$/g, "").replace(/\\(.)/g, "$1")).trim();
    return { email: angle[1]!.trim().toLowerCase(), name: name || null };
  }
  return { email: text.replace(/^"|"$/g, "").toLowerCase(), name: null };
}

/** Decodes RFC 2047 encoded words. Whitespace between two adjacent encoded words is dropped. */
export function decodeEncodedWords(value: string): string {
  const word = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  let out = "";
  let last = 0;
  let previousWasWord = false;
  for (const m of value.matchAll(word)) {
    const gap = value.slice(last, m.index);
    out += previousWasWord && /^\s*$/.test(gap) ? "" : gap;
    const charset = m[1]!.replace(/\*.*$/, "");
    const bytes = m[2]!.toLowerCase() === "b" ? Buffer.from(m[3]!, "base64") : qDecode(m[3]!);
    out += decodeBytes(bytes, charset);
    last = m.index! + m[0].length;
    previousWasWord = true;
  }
  return out + value.slice(last);
}

function qDecode(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "_") bytes.push(0x20);
    else if (ch === "=" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset?.trim().toLowerCase() || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function charsetOf(part: GmailPart): string | undefined {
  const type = part.headers?.find((h) => h.name?.toLowerCase() === "content-type")?.value ?? "";
  return /charset\s*=\s*"?([^";\s]+)"?/i.exec(type)?.[1];
}

function partText(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return "";
  return decodeBytes(Buffer.from(data, "base64url"), charsetOf(part));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "...", ndash: "-", mdash: "-", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"' };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
      if (body[0] === "#") {
        const code = body[1]!.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[body.toLowerCase()] ?? whole;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain text of the message: prefers text/plain, falls back to stripped HTML, keeps bounce report parts. */
function extractBody(part: GmailPart): string {
  const type = (part.mimeType ?? "").toLowerCase();
  if (part.filename) return "";
  if (type === "text/plain" || type === "message/delivery-status") {
    const own = partText(part);
    const nested = (part.parts ?? []).map(extractBody).filter(Boolean);
    return [own, ...nested].filter(Boolean).join("\n\n");
  }
  if (type === "text/html") return htmlToText(partText(part));
  if (type === "multipart/alternative") {
    const children = part.parts ?? [];
    const plain = children.map((c) => (c.mimeType?.toLowerCase() === "text/plain" ? extractBody(c) : "")).find(Boolean);
    if (plain) return plain;
    return children.map(extractBody).find(Boolean) ?? "";
  }
  if (type.startsWith("multipart/")) return (part.parts ?? []).map(extractBody).filter(Boolean).join("\n\n");
  return "";
}

/** Our send id inside an attached original: a message/rfc822 part or a text/rfc822-headers part. */
function findNestedSendId(part: GmailPart): string | null {
  for (const child of part.parts ?? []) {
    const type = (child.mimeType ?? "").toLowerCase();
    if (type === "text/rfc822-headers") {
      const found = new RegExp(`^${SEND_ID}:[ \\t]*(.+)$`, "im").exec(partText(child));
      if (found) return stripAngles(found[1]);
    }
    if (type === "message/rfc822") {
      const direct = stripAngles(headerMap(child.headers).get(SEND_ID));
      if (direct) return direct;
      for (const inner of child.parts ?? []) {
        const viaInner = stripAngles(headerMap(inner.headers).get(SEND_ID)) ?? findNestedSendId(inner);
        if (viaInner) return viaInner;
      }
    }
    const deeper = findNestedSendId(child);
    if (deeper) return deeper;
  }
  return null;
}
