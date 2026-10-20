import { isSupportedCountry } from "libphonenumber-js";

/**
 * Country that reads a phone number written without a country code ("010-1234-5678" with KR).
 * Stored as `defaultPhoneCountry` in the organization's `general` channel settings.
 * The `DEFAULT_PHONE_COUNTRY` environment variable is the fallback while the setting is empty.
 */
export const DEFAULT_PHONE_COUNTRY_KEY = "defaultPhoneCountry";

/** The upper-case ISO 3166-1 alpha-2 code, or null when the value is empty or not a country the phone parser knows. */
export function normalizePhoneCountry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && isSupportedCountry(code) ? code : null;
}

/** Null for an empty value (clears the setting) or a known country. */
export const phoneCountryProblem = (value: string): string | null =>
  value.trim() === "" || normalizePhoneCountry(value) ? null : "Use a two-letter country code such as KR or US.";

/** The organization's setting wins over the environment fallback. */
export const resolvePhoneCountry = (stored: unknown, fallback: unknown): string | null => normalizePhoneCountry(stored) ?? normalizePhoneCountry(fallback);
