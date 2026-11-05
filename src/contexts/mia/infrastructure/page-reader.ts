import { parse } from "node-html-parser";
import { safeRequestBytes, SafeHttpError, type SafeFetchDeps } from "@/platform/safe-http/safe-http";
import { MIA_MAX_LINKS, MIA_PAGE_CHARS, MIA_PAGE_TIMEOUT_MS } from "../domain/mia-run";
import { isSameSite, parsePageUrl, sameSiteLinks } from "../domain/page-url";
import type { PageReader, ReadPage } from "../application/mia-ports";

const MAX_REDIRECTS = 3;
const READABLE = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i;
/** Text a browser would not show, which a page can use to speak to a model behind the reader's back. */
const HIDDEN = 'script, style, noscript, template, svg, iframe, object, embed, head, [hidden], [aria-hidden="true"]';
const HIDDEN_STYLE = /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0+)?\s*(;|$))/i;

function charsetOf(contentType: string, bytes: Uint8Array): string {
  const declared = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  if (declared) return declared;
  // A page may name its encoding only in a meta tag, and that tag is plain ASCII in any of them.
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(Buffer.from(bytes.subarray(0, 2048)).toString("latin1"))?.[1] ?? "utf-8";
}

function decode(bytes: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType, bytes)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const squeeze = (text: string) =>
  text
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** The text a person sees on the page, and the links under it. */
export function readHtml(html: string, page: URL): Omit<ReadPage, "url"> {
  const root = parse(html);
  const title = root.querySelector("title")?.text.trim() ?? "";
  // Links first: the removal below may take a menu that is hidden until a click.
  const hrefs = root.querySelectorAll("a[href]").map((a) => a.getAttribute("href") ?? "");
  for (const node of root.querySelectorAll(HIDDEN)) node.remove();
  for (const node of root.querySelectorAll("[style]")) if (HIDDEN_STYLE.test(node.getAttribute("style") ?? "")) node.remove();
  return { title: title.slice(0, 300), text: squeeze(root.structuredText).slice(0, MIA_PAGE_CHARS), links: sameSiteLinks(hrefs, page, MIA_MAX_LINKS) };
}

/** A sentence the model may read and act on. It names the failure and nothing about this server. */
function reason(error: unknown, url: URL): Error {
  if (error instanceof SafeHttpError) {
    if (error.failure === "blocked") return new Error(`${url.hostname} is a private address and cannot be read.`);
    if (error.failure === "timeout") return new Error(`${url.hostname} did not answer in time.`);
    return new Error(`Could not read ${url.hostname}.`);
  }
  return error instanceof Error ? error : new Error(`Could not read ${url.hostname}.`);
}

/** Reads one page of a public site. Each redirect hop goes through the same checks as the first address. */
export function createPageReader(net: SafeFetchDeps = {}): PageReader {
  return {
    async read(address, signal) {
      const start = parsePageUrl(address);
      if (!start) throw new Error("That is not a public https address.");
      let url = start;
      for (let hop = 0; ; hop++) {
        let response;
        try {
          response = await safeRequestBytes(url, { method: "GET", headers: { accept: "text/html,text/plain;q=0.9", "user-agent": "MiaSDR" } }, MIA_PAGE_TIMEOUT_MS, net, { redirects: "return", overflow: "truncate", signal });
        } catch (error) {
          throw reason(error, url);
        }
        if (response.status >= 300 && response.status < 400) {
          const next = parsePageUrl(response.headers.get("location") ?? "", url.href);
          if (!next || !isSameSite(next, start)) throw new Error(`${url.hostname} redirects to another site.`);
          if (hop >= MAX_REDIRECTS) throw new Error(`${url.hostname} redirects too many times.`);
          url = next;
          continue;
        }
        if (response.status >= 400) throw new Error(`${url.hostname} answered with status ${response.status}.`);
        if (!READABLE.test(response.contentType)) throw new Error("That page is not text or HTML.");
        const body = decode(response.bytes, response.contentType);
        const read = /^text\/plain/i.test(response.contentType) ? { title: "", text: squeeze(body).slice(0, MIA_PAGE_CHARS), links: [] } : readHtml(body, url);
        if (read.text === "") throw new Error("That page has no text to read. It may draw itself with scripts.");
        return { url: url.href, ...read };
      }
    },
  };
}
