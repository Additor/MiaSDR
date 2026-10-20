/**
 * Email rendering. Order matters and is shared by preview and send:
 * spin text, merge fields, signature, HTML conversion, unsubscribe footer.
 */

const SPIN = /\{([^{}]+)\}/g;
const MERGE = /\{\{\s*([^{}\r\n]+?)\s*\}\}/g;
const SIGNATURE_PLACEHOLDER = /%\s*signature\s*%/gi;
const LEGACY_SIGNATURE = /\{\{\s*signature\s*\}\}/gi;

/** `{A|B|C}` becomes one option. Groups without a `|` are left alone. Runs on the template only. */
export function applySpin(template: string, random: () => number): string {
  return template.replace(SPIN, (whole, inner: string) => {
    if (!inner.includes("|")) return whole;
    const options = inner.split("|").map((o) => o.trim());
    return options[Math.floor(random() * options.length)] ?? "";
  });
}

/** Like `applySpin`, but takes the longest option of every group. The length preview uses it so the worst case is what gets flagged. */
export function applySpinLongest(template: string): string {
  return template.replace(SPIN, (whole, inner: string) => {
    if (!inner.includes("|")) return whole;
    return inner.split("|").map((o) => o.trim()).reduce((a, b) => (b.length > a.length ? b : a), "");
  });
}

/** Every distinct `{{ field }}` name in a template, in order of first use. `signature` is not a field. */
export function mergeTokens(template: string): string[] {
  const seen = new Map<string, string>();
  for (const match of template.matchAll(MERGE)) {
    const token = match[1].trim();
    if (token.toLowerCase() !== "signature" && !seen.has(token.toLowerCase())) seen.set(token.toLowerCase(), token);
  }
  return [...seen.values()];
}

const EMPTY_MARK = "\u0001";
const EMPTY_RUN = new RegExp(`([ \\t]*)${EMPTY_MARK}(?:[ \\t]*${EMPTY_MARK})*([ \\t]*)`, "g");

/**
 * `{{ key }}` is replaced from `variables` (case-insensitive). Missing keys become empty. `signature` is kept for the next step.
 * A field that comes out empty also takes one of the spaces around it, so "Hi {{firstName}} there" does not become "Hi  there"
 * and "Hi {{firstName}}, welcome" does not become "Hi , welcome".
 */
export function applyMergeFields(text: string, variables: Record<string, string | null | undefined>): string {
  const lookup = new Map(Object.entries(variables).map(([k, v]) => [k.toLowerCase(), v ?? ""]));
  const filled = text.replace(MERGE, (whole, key: string) => {
    const name = key.trim().toLowerCase();
    if (name === "signature") return whole;
    const value = (lookup.get(name) ?? "").replaceAll(EMPTY_MARK, "");
    return value === "" ? EMPTY_MARK : value;
  });
  if (!filled.includes(EMPTY_MARK)) return filled;
  return filled.replace(EMPTY_RUN, (_whole, before: string, after: string, offset: number, whole: string) => {
    const next = whole.charAt(offset + _whole.length);
    const atLineStart = offset === 0 || whole.charAt(offset - 1) === "\n";
    const nextIsBreakOrPunct = next === "" || /[\n\r,.;:!?)\]]/.test(next);
    if (before && after) return atLineStart ? "" : " ";
    if (before) return nextIsBreakOrPunct ? "" : before;
    if (after) return atLineStart ? "" : after;
    return "";
  });
}

/** Places the signature at its placeholder, or appends it. Without a signature the placeholder is removed. */
export function applySignature(body: string, signatureHtml: string | null | undefined): string {
  const signature = signatureHtml?.trim() ?? "";
  const hasPlaceholder = new RegExp(SIGNATURE_PLACEHOLDER.source, "i").test(body) || new RegExp(LEGACY_SIGNATURE.source, "i").test(body);
  const stripped = body.replace(SIGNATURE_PLACEHOLDER, "\u0000SIG\u0000").replace(LEGACY_SIGNATURE, "\u0000SIG\u0000");
  if (!signature) return stripped.replace(/\u0000SIG\u0000/g, "").trimEnd();
  if (hasPlaceholder) return stripped.replace(/\u0000SIG\u0000/g, signature);
  return `${body.trimEnd()}\n\n${signature}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const LINK = /(https?:\/\/[^\s<]+)|([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

/** Plain text to HTML: escape, link URLs and addresses, keep line breaks. The signature may carry its own HTML. */
export function toHtmlBody(text: string): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(LINK, (match, url?: string) => {
    if (url) {
      const trimmed = url.replace(/[.,;:!?)\]]+$/, "");
      const tail = url.slice(trimmed.length);
      return `<a href="${trimmed}">${trimmed}</a>${tail}`;
    }
    return `<a href="mailto:${match}">${match}</a>`;
  });
  return linked.replace(/\r?\n/g, "<br />");
}

export function unsubscribeFooter(url: string): { text: string; html: string } {
  return {
    text: `\n\n---\nDon't want to hear from us again? Unsubscribe: ${url}`,
    html: `<br /><br /><span style="color:#888888;font-size:12px">Don't want to hear from us again? <a href="${escapeHtml(url)}" style="color:#888888">Unsubscribe</a></span>`,
  };
}

export interface RenderInput {
  subjectTemplate: string;
  bodyTemplate: string;
  variables: Record<string, string | null | undefined>;
  signatureHtml: string | null | undefined;
  unsubscribeUrl: string;
  random: () => number;
}

export interface RenderedEmail {
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

export function renderEmail(input: RenderInput): RenderedEmail {
  const fill = (template: string) => applyMergeFields(applySpin(template, input.random), input.variables);
  const subject = fill(input.subjectTemplate).replace(/\s+/g, " ").trim();
  const body = applySignature(fill(input.bodyTemplate), input.signatureHtml);
  const footer = unsubscribeFooter(input.unsubscribeUrl);
  return {
    subject,
    bodyText: `${body}${footer.text}`,
    bodyHtml: `${toHtmlBody(body)}${footer.html}`,
  };
}
