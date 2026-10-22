// Pure rules for reading a LinkedIn profile reference: a public slug, or a member id from a
// Sales Navigator, Recruiter or classic provider id. No I/O.
import { linkedinSlug } from "./linkedin";

/** A Unipile provider id (ACo..., ACw..., AE...). It is case sensitive, so callers must never lowercase it. */
export const PROVIDER_ID = /^A(Co|Cw|E)[A-Za-z0-9_-]+$/;

export type LinkedInApi = "classic" | "sales_navigator" | "recruiter";

export type ProfileRef = { kind: "public"; slug: string } | { kind: "member"; api: LinkedInApi; memberId: string };

const MIN_MEMBER_ID = 10;
/** A bare token (no URL) is a provider id only from this length. Real ids run about 39 characters; shorter tokens such as "ACostaMaria" are slugs. */
export const MIN_BARE_PROVIDER_ID = 20;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// The id segment runs to the next `?`, `/` or `#`; the id itself is cut at the first `,` after decoding, so `%2C` separates like `,`.
const SALES_PATH = /^\/sales\/(?:lead|people)\/([^?/#]+)/i;
const RECRUITER_PATH = /^\/talent\/(?:profile\/|hire\/[^/]+\/profile\/)([^?/#]+)/i;

/** The member id of a path segment: percent-decoded, cut at the first comma. */
function segmentId(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  return decoded.split(",")[0];
}

/** Lowercases and decodes a public slug the way the people context stores it, so a write-back matches an import. */
export function normalizePublicSlug(value: string | null | undefined): string | null {
  let slug = (value ?? "").trim();
  if (!slug) return null;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep the raw slug
  }
  slug = slug.toLowerCase();
  return slug.length > 0 && slug.length <= 100 ? slug : null;
}

/** A bare token that reads as a provider id: the prefix, the safe alphabet and at least 20 characters. */
export function isBareProviderId(text: string): boolean {
  return text.length >= MIN_BARE_PROVIDER_ID && PROVIDER_ID.test(text);
}

function isMemberId(id: string): boolean {
  return id.length >= MIN_MEMBER_ID && SAFE_ID.test(id);
}

function parseUrl(text: string): URL | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
}

const isLinkedinHost = (host: string) => host === "linkedin.com" || host.endsWith(".linkedin.com");

/**
 * Sales Navigator and Recruiter URLs carry a member id in the path, cut at the first `,`, `?` or `/`.
 * Returns null for any URL that is not one of those.
 */
export function parseMemberUrl(text: string): { api: "sales_navigator" | "recruiter"; memberId: string } | null {
  const url = parseUrl(text.trim());
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || !isLinkedinHost(url.hostname.toLowerCase())) return null;
  const sales = url.pathname.match(SALES_PATH);
  const salesId = sales ? segmentId(sales[1]) : null;
  if (salesId && isMemberId(salesId)) return { api: "sales_navigator", memberId: salesId };
  const recruiter = url.pathname.match(RECRUITER_PATH);
  const recruiterId = recruiter ? segmentId(recruiter[1]) : null;
  if (recruiterId && isMemberId(recruiterId)) return { api: "recruiter", memberId: recruiterId };
  return null;
}

/**
 * Reads what a stored identifier points at. A `/in/<slug>` URL or a bare slug is public (existing slug logic),
 * a Sales Navigator or Recruiter URL or a bare provider id is a member id, anything else is null.
 */
export function parseLinkedInProfileRef(input: string): ProfileRef | null {
  const text = (input ?? "").trim();
  if (!text || /\s/.test(text)) return null;

  if (!/[/.]/.test(text) && isBareProviderId(text)) return { kind: "member", api: "classic", memberId: text };

  const member = parseMemberUrl(text);
  if (member) return { kind: "member", ...member };

  const slug = linkedinSlug(text);
  if (!slug) return null;
  // A bare word is a slug. A URL must be an /in/ URL on a linkedin.com host, which linkedinSlug already checks.
  return { kind: "public", slug };
}

/**
 * The member id of a search result, or null. A classic result links to /in/<member id> when the person has no
 * public slug; a Sales Navigator result links to /sales/lead/<id>; the identifier is a bare id.
 */
export function resultMemberId(item: { identifier: string; profileUrl: string | null }): string | null {
  for (const candidate of [item.profileUrl, item.identifier]) {
    const text = candidate?.trim();
    if (!text) continue;
    const inPath = text.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
    if (inPath && /^AC[ow][A-Za-z0-9_-]{16,}$/.test(inPath[1])) return inPath[1];
    if (/^AC[ow][A-Za-z0-9_-]{16,}$/.test(text)) return text;
    const ref = parseLinkedInProfileRef(text);
    if (ref?.kind === "member") return ref.memberId;
  }
  return null;
}

/** Same shape as the people context's canonical URL, so a write-back matches what an import stores. */
export function canonicalProfileUrl(slug: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`;
}

/** True when a stored LinkedIn URL points at a member id (Sales Navigator, Recruiter, bare id) and is safe to replace with a profile URL. */
export function isMemberReference(url: string | null): boolean {
  return url !== null && parseLinkedInProfileRef(url)?.kind === "member";
}
