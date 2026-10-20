/** An organization's URL name: lowercase letters, numbers and dashes. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const FALLBACK_SLUG = "organization";
const SLUG_MAX = 48;

/**
 * Every candidate `uniqueSlug` tries starts with this prefix: a long base is cut to make room for `-2`, `-10` and so on,
 * and a suffix up to 8 characters long (`-1000000`) still leaves these first characters intact. A store lists the
 * slugs that start with it, so the cut candidates count as taken.
 */
export function slugPrefix(base: string): string {
  return base.slice(0, SLUG_MAX - 8);
}

/**
 * The first free slug for a name: the slugified name, then `-2`, `-3` and so on.
 * A name with no letters or digits falls back to "organization".
 */
export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const base = slugify(name) || FALLBACK_SLUG;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
