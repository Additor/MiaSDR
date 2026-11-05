/**
 * Which pages a run may read. A person names the first page, and every other one comes from a link on a page already
 * read, on the same site. A model cannot write an address of its own, so it cannot carry anything out in a query string.
 */

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const MAX_URL = 2048;

/** An https address on the default port, with a public-looking name. Null for anything else: an IP address, a password in the URL, another port. */
export function parsePageUrl(raw: string, base?: string): URL | null {
  const text = raw.trim();
  if (text === "" || text.length > MAX_URL) return null;
  let url: URL;
  try {
    url = base === undefined ? new URL(text) : new URL(text, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const hostname = url.hostname.toLowerCase();
  // A name that ends in digits is an IP address. No public domain ends that way.
  if (!HOSTNAME.test(hostname) || /\.\d+$/.test(hostname)) return null;
  url.hash = "";
  return url;
}

const withoutWww = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** The same host, or the same one with or without `www.`. A subdomain is another site: `a.vercel.app` and `b.vercel.app` belong to strangers. */
export const isSameSite = (a: URL, b: URL): boolean => withoutWww(a.hostname) === withoutWww(b.hostname);

/** The site's own links out of what a page holds, each once, in page order. */
export function sameSiteLinks(hrefs: readonly string[], page: URL, limit: number): string[] {
  const found = new Set<string>();
  for (const href of hrefs) {
    if (found.size >= limit) break;
    const url = parsePageUrl(href, page.href);
    if (url && isSameSite(url, page) && url.href !== page.href) found.add(url.href);
  }
  return [...found];
}
