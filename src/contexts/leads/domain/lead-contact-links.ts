/*
 * The links of the lead page header. Each helper returns null when the value cannot make a safe link, so the view
 * shows plain text or nothing instead of a broken or unsafe href.
 */

export function mailtoHref(email: string | null | undefined): string | null {
  const value = email?.trim();
  if (!value || /[\s<>"]/.test(value) || !value.includes("@")) return null;
  return `mailto:${value}`;
}

/** Phone numbers are stored as E.164. The href keeps a leading plus and digits only. */
export function telHref(phone: string | null | undefined): string | null {
  const value = phone?.trim();
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 5) return null;
  return `tel:${value.startsWith("+") ? "+" : ""}${digits}`;
}

/** The profile URL for a new tab. Only http and https open: an imported value like "javascript:..." never becomes a link. */
export function profileHref(url: string | null | undefined): string | null {
  const value = url?.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
