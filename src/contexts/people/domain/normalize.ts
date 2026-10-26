import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { BARE_SLUG } from "./linkedin-slug";

export { customColumnKey, CUSTOM_LABEL_MAX, mergeFieldKey } from "./custom-fields";
export { normalizeEmail } from "@/shared/email";

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const blank = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};


/** A bare domain from a URL, an email address or a domain; null when none can be read. */
export function normalizeDomain(value: string | null | undefined): string | null {
  let text = blank(value)?.toLowerCase();
  if (!text) return null;
  if (text.includes("@")) text = text.split("@").pop() ?? "";
  text = text
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  return DOMAIN.test(text) ? text : null;
}

/**
 * The profile slug from a LinkedIn /in/ URL, or a bare slug. Company pages
 * and other URLs return null: `people.linkedin_slug` holds people only.
 */
export function normalizeLinkedinSlug(value: string | null | undefined): string | null {
  const text = blank(value);
  if (!text) return null;
  let slug: string;
  if (/linkedin\.com/i.test(text)) {
    const match = text.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
    if (!match) return null;
    slug = match[1];
  } else if (BARE_SLUG.test(text)) {
    slug = text;
  } else {
    return null;
  }
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep the raw slug
  }
  slug = slug.toLowerCase();
  return slug.length > 0 && slug.length <= 100 ? slug : null;
}

/** E.164, or null when the number cannot be read as valid. */
export function normalizePhone(value: string | null | undefined, defaultCountry?: string): string | null {
  const text = blank(value);
  if (!text) return null;
  const parsed = parsePhoneNumberFromString(text, defaultCountry as CountryCode | undefined);
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * Splits a full name on the first whitespace run: "Mary Ann Smith" gives first "Mary", last "Ann Smith".
 * One token is a first name only (a Korean name written without a space stays whole).
 */
export function splitFullName(fullName: string | null | undefined): { first: string | null; last: string | null } {
  const text = blank(fullName)?.replace(/\s+/g, " ") ?? null;
  if (!text) return { first: null, last: null };
  const at = text.indexOf(" ");
  if (at === -1) return { first: text, last: null };
  return { first: text.slice(0, at), last: text.slice(at + 1) || null };
}

/**
 * Parts supplied by the file always win. The full name only fills the part that is missing.
 */
export function resolvePersonNames(input: { first: string | null; last: string | null; full: string | null }): {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
} {
  const split = input.first && input.last ? { first: null, last: null } : splitFullName(input.full);
  const firstName = input.first ?? split.first;
  const lastName = input.last ?? split.last;
  return { firstName, lastName, fullName: input.full ?? ([firstName, lastName].filter(Boolean).join(" ") || null) };
}

/** Mail providers whose domain says nothing about the lead's employer. */
export const WEBMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.co.kr", "yahoo.co.jp",
  "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net",
  "zoho.com", "mail.com", "yandex.com", "naver.com", "kakao.com", "hanmail.net", "daum.net", "nate.com", "qq.com", "163.com",
  "126.com", "sina.com", "web.de", "t-online.de", "orange.fr", "free.fr", "wanadoo.fr", "libero.it", "mail.ru",
]);

/** The company domain an email address implies, or null for webmail and unreadable addresses. */
export function inferCompanyDomain(email: string | null | undefined): string | null {
  const domain = normalizeDomain(email);
  if (!domain || !(email ?? "").includes("@")) return null;
  return WEBMAIL_DOMAINS.has(domain) ? null : domain;
}

/** `https://www.linkedin.com/company/<slug>/` from a company page URL, or null for anything else. */
export function normalizeCompanyLinkedinUrl(value: string | null | undefined): string | null {
  const text = blank(value);
  if (!text || text.length > 2048) return null;
  const match = text.match(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/(?:company|school)\/([^/?#\s]+)/i);
  if (!match) return null;
  let slug = match[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep the raw slug
  }
  slug = slug.toLowerCase();
  return slug ? `https://www.linkedin.com/company/${encodeURIComponent(slug)}/` : null;
}

export { blank as blankToNull };
