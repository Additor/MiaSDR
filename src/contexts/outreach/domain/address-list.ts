/** Parsing of RFC 5322 address-list headers (To, Cc, Resent-Cc). Pure: no I/O. */

export interface ParsedAddress {
  email: string;
  /** Display name as written (RFC 2047 words are not decoded here). */
  name: string | null;
}

const EMAIL = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/;
const MAX_EMAIL_LENGTH = 320;

/** An address as a header carries it, trimmed and lowercased. `normalizeEmail` in `@/shared/email` also validates. */
const lowerAddress = (value: string): string => value.trim().toLowerCase();

export function isValidEmail(value: string): boolean {
  return value.length <= MAX_EMAIL_LENGTH && EMAIL.test(value);
}

/**
 * Parses one address-list header value. Handles quoted display names with
 * commas, comments, group syntax (`Team: a@x.com, b@x.com;`) and addr-spec
 * without brackets. Invalid entries are dropped; the rest are lowercased and
 * deduplicated in order.
 */
export function parseAddressList(value: string | null | undefined): ParsedAddress[] {
  if (!value || !value.trim()) return [];
  const out: ParsedAddress[] = [];
  for (const entry of splitTopLevel(value)) {
    const parsed = parseMailbox(entry);
    if (parsed) out.push(parsed);
  }
  return dedupeAddresses(out);
}

/** Splits on commas and group delimiters that sit outside quotes, comments and angle brackets. */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  let comment = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quoted) {
      current += ch;
      if (ch === "\\" && i + 1 < value.length) current += value[++i];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (comment > 0) {
      current += ch;
      if (ch === "\\" && i + 1 < value.length) current += value[++i];
      else if (ch === "(") comment++;
      else if (ch === ")") comment--;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "(") comment++;
    else if (ch === "<") angle = true;
    else if (ch === ">") angle = false;
    if (!angle && (ch === "," || ch === ";")) {
      out.push(current);
      current = "";
    } else if (!angle && ch === ":") {
      // Group name ends here: drop it, keep reading members.
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

function stripComments(text: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) out += text[++i];
      else if (ch === '"') quoted = false;
    } else if (depth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    } else if (ch === "(") depth++;
    else {
      if (ch === '"') quoted = true;
      out += ch;
    }
  }
  return out.trim();
}

function unquote(text: string): string {
  const t = text.trim();
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1).replace(/\\(.)/g, "$1") : t;
}

function parseMailbox(entry: string): ParsedAddress | null {
  const text = stripComments(entry);
  const angle = /<([^<>]*)>\s*$/.exec(text);
  let email: string;
  let name: string | null = null;
  if (angle) {
    email = lowerAddress(unquote(angle[1]!));
    name = unquote(text.slice(0, angle.index)).trim() || null;
  } else {
    email = lowerAddress(unquote(text));
  }
  if (!isValidEmail(email)) return null;
  if (name && name.toLowerCase() === email) name = null;
  return { email, name };
}

/** Keeps the first occurrence of each address (case-insensitive), preserving order. */
export function dedupeAddresses<T extends { email: string }>(list: T[], exclude: Iterable<string> = []): T[] {
  const seen = new Set(Array.from(exclude, lowerAddress));
  const out: T[] = [];
  for (const item of list) {
    const email = lowerAddress(item.email);
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ ...item, email });
  }
  return out;
}
