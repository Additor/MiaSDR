const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Lowercased, trimmed, without a `mailto:` prefix, or null when it is not an address. */
export function normalizeEmail(value: string | null | undefined): string | null {
  const email = (value ?? "").trim().toLowerCase().replace(/^mailto:/, "");
  return email !== "" && EMAIL.test(email) ? email : null;
}
