import type { GatewayProfile, NetworkDistance, SearchItem } from "../../../application/linkedin-ports";

const ACOAA = /^ACoAA[\w-]+$/;
const PROFILE_URL = /^https:\/\/(?:(?:www|[a-z]{2})\.)?linkedin\.com\/(?:in|pub|sales\/people|sales\/lead)\/[^\s/]+/i;
const BARE_ID = /^AC[\w-]{20,}$/;
const BARE_SLUG = /^[\w%-]+$/;

export type Json = Record<string, unknown>;
export const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
export const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
export const rows = (value: unknown): Json[] => (Array.isArray(value) ? value.map(obj) : []);
export const firstOf = (body: unknown): Json => (Array.isArray(body) ? obj(body[0]) : obj(body));

/** The ACoAA member id every engine keys on. An ACwAA Sales Navigator id is not one. */
export const acoaaOf = (value: unknown): string | null => {
  const id = str(value);
  return id && ACOAA.test(id) ? id : null;
};

/** A numeric LinkedIn member id as a string. */
export function memberIdOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return String(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return null;
}

const inUrl = (id: string) => `https://www.linkedin.com/in/${encodeURIComponent(id)}`;

/** The `linkedin_profile_url` for a lookup: a URL Edges takes as is, an AC id or a bare slug under `/in/`. */
export function lookupUrl(identifier: string): string | null {
  const value = identifier.trim();
  if (PROFILE_URL.test(value)) return value.replace(/^https:\/\/(?:[a-z]{2}\.)?linkedin\.com/i, "https://www.linkedin.com");
  if (BARE_ID.test(value) || BARE_SLUG.test(value)) return inUrl(value);
  return null;
}

/** The public slug first: `/in/<ACoAA>` was only checked for lookups, and answers those with fewer fields. */
export const recipientUrl = (to: { member: string | null; slug: string | null }): string | null => (to.slug ? inUrl(to.slug) : to.member ? inUrl(to.member) : null);

/** A profile URL that is public, not a hashed id. */
export function publicProfileUrl(url: unknown): string | null {
  const value = str(url);
  const slug = value?.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
  return value && slug && !/^AC[\w-]{20,}$/.test(slug) ? value : null;
}

function distanceOf(raw: unknown): NetworkDistance {
  const text = String(raw ?? "").toLowerCase();
  if (/^(1|1st|first|distance_1)/.test(text)) return "first";
  if (/^(2|2nd|second|distance_2)/.test(text)) return "second";
  if (/^(3|3rd|third|distance_3)/.test(text)) return "third";
  return "unknown";
}

/** `linkedin-extract-people` as a profile; null when it names no ACoAA id, which every send needs. */
export function profileFrom(body: unknown): GatewayProfile | null {
  const p = firstOf(body);
  const member = acoaaOf(p.sales_navigator_profile_id);
  if (!member) return null;
  const urlSlug = str(p.linkedin_profile_url)?.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1] ?? null;
  return {
    member,
    publicSlug: str(p.linkedin_profile_handle)?.toLowerCase() ?? (urlSlug && !/^ac[\w-]{20,}$/i.test(urlSlug) ? urlSlug.toLowerCase() : null),
    firstName: str(p.first_name),
    lastName: str(p.last_name),
    headline: str(p.headline),
    location: str(p.location),
    pictureUrl: str(p.profile_image_url),
    networkDistance: distanceOf(p.connection_degree),
    isPremium: false,
  };
}

/** `linkedin-me` as the account's own profile; null when it names no ACoAA id. */
export function ownProfileFrom(body: unknown): GatewayProfile | null {
  const me = firstOf(body);
  const member = acoaaOf(me.sales_navigator_profile_id);
  if (!member) return null;
  const title = str(me.job_title);
  return {
    member,
    publicSlug: str(me.handle)?.toLowerCase() ?? null,
    firstName: str(me.first_name) ?? str(me.full_name),
    lastName: str(me.last_name),
    // LinkedIn answers "--" for an empty headline.
    headline: title && title !== "--" ? title : null,
    location: null,
    pictureUrl: str(me.profile_image_url),
    networkDistance: "unknown",
    isPremium: me.premium_subscriber === true,
  };
}

export function searchItemFrom(raw: unknown): SearchItem | null {
  const item = obj(raw);
  const handle = str(item.linkedin_profile_handle);
  const profileUrl = str(item.linkedin_profile_url) ?? (handle ? inUrl(handle) : null);
  const identifier = handle ?? profileUrl ?? str(item.sales_navigator_profile_id);
  if (!identifier) return null;
  return {
    identifier,
    profileUrl,
    name: str(item.full_name) ?? ([str(item.first_name), str(item.last_name)].filter(Boolean).join(" ") || null),
    headline: str(item.headline) ?? str(item.job_title),
    location: str(item.location),
    networkDistance: str(item.connection_degree),
    raw: item,
  };
}

/** Edges' dates sometimes arrive JSON-quoted. Milliseconds, or NaN. */
export function edgesTime(raw: unknown): number {
  const text = str(raw)?.replace(/^"+|"+$/g, "");
  return text ? Date.parse(text) : Number.NaN;
}

export const normalizedText = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
