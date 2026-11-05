import { normalizePublicSlug } from "../../../domain/linkedin-identity";
import { linkedinSlug, profileUrlFor } from "../../../domain/linkedin";
import type { LinkedInRecipient } from "../../../application/linkedin-ports";

export type Row = Record<string, unknown>;
export const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
export const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

const HASHED = /linkedin\.com\/in\/([^/?#]+)/i;
const MEMBER = /^ACoAA[A-Za-z0-9_-]+$/;
/** Any hashed form: a Sales Navigator ACwAA id as well as a member id. */
const ANY_HASH = /^AC[A-Za-z0-9_-]{20,}$/;

const lastPart = (url: unknown): string | null => {
  const match = str(url)?.match(HASHED)?.[1];
  return match ? decodeURIComponent(match) : null;
};

/** The ACoAA member id a hashed URL carries, the same id the other vendors use. Null for any other form. */
export function memberOf(url: unknown): string | null {
  const part = lastPart(url);
  return part && MEMBER.test(part) ? part : null;
}

/** The public slug of a profile URL, never a hash. */
export function slugOf(url: unknown): string | null {
  const part = lastPart(url);
  return part && !MEMBER.test(part) && !ANY_HASH.test(part) ? normalizePublicSlug(part) : null;
}

/** The address an action takes for a person: the hash survives a vanity-URL change, so it goes first. */
export function personUrlOf(to: { member: string | null; slug: string | null }): string | null {
  if (to.member) return `https://www.linkedin.com/in/${to.member}`;
  return to.slug ? profileUrlFor(to.slug) : null;
}

/** The address of a lookup: a stored slug, profile URL or bare member id. */
export function lookupUrlOf(identifier: string): string | null {
  if (ANY_HASH.test(identifier)) return `https://www.linkedin.com/in/${identifier}`;
  const slug = linkedinSlug(identifier);
  return slug ? profileUrlFor(slug) : null;
}

/** A real thread. The inbox files a chat with no id under a made-up `member:` name, which Linked API cannot address. */
export function threadOf(to: LinkedInRecipient): string | null {
  return to.chat && !to.chat.startsWith("member:") ? to.chat : null;
}

export function splitName(full: unknown) {
  const [first, ...rest] = (str(full) ?? "").split(/\s+/);
  return { firstName: first || null, lastName: rest.join(" ") || null };
}

/** A person's messages since `since`, as `/inbox/poll` lists them: its times are whole minutes and its `since` is inclusive. */
export const minuteOf = (at: Date) => new Date(Math.floor(at.getTime() / 60_000) * 60_000);
