import { blankToNull, normalizeLinkedinSlug } from "./normalize";

/** A person a LinkedIn search returned. `key` is the caller's handle for matching the answer back. */
export interface FoundPersonInput {
  key: string;
  /** Profile URL or public slug. */
  profile: string;
  name: string | null;
  headline: string | null;
  /** Provider member id of a result with no public slug. Used only when `profile` holds no slug. */
  memberId?: string | null;
  /** Profile URL the provider gave (for example a Sales Navigator link), kept as `linkedin_url` of a lead created without a slug. */
  url?: string | null;
}

export interface FoundCandidate {
  key: string;
  /** Null for a candidate known only by its member id. */
  slug: string | null;
  memberId?: string | null;
  url?: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
}

export interface ExistingFoundPerson {
  id: string;
  linkedinSlug: string | null;
  /** `raw.linkedin_member_id` of the stored lead. */
  memberId?: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
}

type Field = "firstName" | "lastName" | "fullName" | "title";

export interface FoundPlan {
  inserts: FoundCandidate[];
  /** Existing people that lack a value this search knows. Only empty fields are filled. */
  fills: Array<{ id: string; patch: Partial<Record<Field, string>> }>;
}

const PLACEHOLDER_NAMES = /^(linkedin member|sales navigator member)$/i;

/** "Jane van Doe, MBA" becomes first "Jane", last "van Doe". A single word is a first name. */
export function splitName(raw: string | null): { firstName: string | null; lastName: string | null; fullName: string | null } {
  const cleaned = blankToNull(raw?.split(",")[0]?.replace(/\s+/g, " "));
  if (!cleaned || PLACEHOLDER_NAMES.test(cleaned)) return { firstName: null, lastName: null, fullName: null };
  const [first, ...rest] = cleaned.split(" ");
  return { firstName: first, lastName: rest.length > 0 ? rest.join(" ") : null, fullName: cleaned };
}

/**
 * Reads each input's profile slug, else its member id. Inputs with neither (company pages, unreadable links) are returned as skipped.
 * Repeated slugs or member ids keep the first.
 */
export function toFoundCandidates(inputs: FoundPersonInput[]): { candidates: FoundCandidate[]; skipped: string[] } {
  const seen = new Map<string, FoundCandidate>();
  const skipped: string[] = [];
  for (const input of inputs) {
    const slug = normalizeLinkedinSlug(input.profile);
    const memberId = slug ? null : blankToNull(input.memberId);
    const identity = slug ? `s:${slug}` : memberId ? `m:${memberId}` : null;
    if (!identity) {
      skipped.push(input.key);
      continue;
    }
    if (seen.has(identity)) continue;
    seen.set(identity, { key: input.key, slug, memberId, url: slug ? null : blankToNull(input.url), ...splitName(input.name), title: blankToNull(input.headline) });
  }
  return { candidates: [...seen.values()], skipped };
}

/**
 * Decides which candidates create a lead and which fill gaps in one. A stored value is never replaced:
 * a search result is a weaker source than anything a person typed or imported.
 */
export function planFoundPeople(candidates: FoundCandidate[], existing: ExistingFoundPerson[]): FoundPlan {
  const bySlug = new Map(existing.flatMap((p) => (p.linkedinSlug ? [[p.linkedinSlug, p] as const] : [])));
  const byMember = new Map(existing.flatMap((p) => (p.memberId ? [[p.memberId, p] as const] : [])));
  const plan: FoundPlan = { inserts: [], fills: [] };
  for (const c of candidates) {
    const match = c.slug ? bySlug.get(c.slug) : c.memberId ? byMember.get(c.memberId) : undefined;
    if (!match) {
      plan.inserts.push(c);
      continue;
    }
    const patch: Partial<Record<Field, string>> = {};
    for (const field of ["firstName", "lastName", "fullName", "title"] as const) {
      if (blankToNull(match[field]) === null && c[field] !== null) patch[field] = c[field] as string;
    }
    if (Object.keys(patch).length > 0) plan.fills.push({ id: match.id, patch });
  }
  return plan;
}
