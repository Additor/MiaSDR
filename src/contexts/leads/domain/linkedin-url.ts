import { normalizeLinkedinSlug } from "./normalize";

export type LinkedinRef =
  /** A person profile. `url` is canonical: https://www.linkedin.com/in/<slug>/ */
  | { kind: "profile"; slug: string; url: string }
  /** A Sales Navigator or Recruiter URL, or a bare provider id. Kept as typed; `memberId` identifies the person until a resolve finds the slug. */
  | { kind: "member"; slug: null; url: string; memberId: string; api: "classic" | "sales_navigator" | "recruiter" }
  /** A LinkedIn page that is not a person profile (company, /pub/). Kept as given. */
  | { kind: "other"; slug: null; url: string };

const MAX_URL_LENGTH = 2048;

export function canonicalProfileUrl(slug: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`;
}

function parseHttpUrl(text: string): URL | null {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Same shapes as `parseLinkedInProfileRef` in the outreach context (a provider id is case sensitive; a bare token is an id from 20 characters, a URL id from 10). */
const PROVIDER_ID = /^A(Co|Cw|E)[A-Za-z0-9_-]{17,}$/;
// The id segment runs to the next `?`, `/` or `#`; the id is cut at the first `,` after decoding, so `%2C` separates like `,`.
const MEMBER_PATHS: Array<[RegExp, "sales_navigator" | "recruiter"]> = [
  [/^\/sales\/(?:lead|people)\/([^?/#]+)/i, "sales_navigator"],
  [/^\/talent\/(?:profile\/|hire\/[^/]+\/profile\/)([^?/#]+)/i, "recruiter"],
];

function segmentId(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  return decoded.split(",")[0];
}

const isLinkedinHost = (host: string) => host === "linkedin.com" || host.endsWith(".linkedin.com");

/**
 * Reads a LinkedIn value from an import cell or a form. A profile URL (or a
 * bare slug) becomes a canonical URL plus slug. A Sales Navigator or Recruiter
 * URL, or a bare provider id, keeps its member id. Any other linkedin.com page is
 * kept as typed with no slug.
 * Values on other hosts, and text that is not a URL or slug, return null.
 */
export function parseLinkedinRef(value: string | null | undefined): LinkedinRef | null {
  const text = (value ?? "").trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;

  if (PROVIDER_ID.test(text)) return { kind: "member", slug: null, url: text, memberId: text, api: "classic" };

  if (/^[\w%.-]+$/.test(text) && !/linkedin\.com/i.test(text)) {
    const slug = normalizeLinkedinSlug(text);
    return slug ? { kind: "profile", slug, url: canonicalProfileUrl(slug) } : null;
  }

  const url = parseHttpUrl(text);
  if (!url || !isLinkedinHost(url.hostname.toLowerCase())) return null;

  for (const [pattern, api] of MEMBER_PATHS) {
    const segment = url.pathname.match(pattern)?.[1];
    const memberId = segment ? segmentId(segment) : null;
    if (memberId && /^[A-Za-z0-9_-]{10,}$/.test(memberId)) return { kind: "member", slug: null, url: text, memberId, api };
  }

  const isSalesHost = /^(sales|business|recruiter)\./i.test(url.hostname);
  const match = isSalesHost ? null : url.pathname.match(/^\/in\/([^/]+)/i);
  const slug = match ? normalizeLinkedinSlug(`linkedin.com/in/${match[1]}`) : null;
  if (slug) return { kind: "profile", slug, url: canonicalProfileUrl(slug) };
  return { kind: "other", slug: null, url: text };
}
