export const MAX_TAGS = 50;
export const MAX_TAG_LENGTH = 80;

/**
 * Lowercases, trims, drops empty entries and repeats (first spelling wins the position). Never throws: matching
 * uses this on step tags that were stored before the limits existed.
 */
export function normalizeTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const entry of raw) {
    const tag = entry.trim().toLowerCase().replace(/\s+/g, " ");
    if (tag !== "") seen.add(tag);
  }
  return [...seen];
}

/** Input check for a document's tags: normalized tags or the reason they are refused. */
export function parseTags(raw: readonly string[]): { tags: string[]; problem: null } | { tags: null; problem: string } {
  const tags = normalizeTags(raw);
  const tooLong = tags.find((t) => t.length > MAX_TAG_LENGTH);
  if (tooLong !== undefined) return { tags: null, problem: `Each tag must be at most ${MAX_TAG_LENGTH} characters.` };
  if (tags.length > MAX_TAGS) return { tags: null, problem: `A document can have at most ${MAX_TAGS} tags.` };
  return { tags, problem: null };
}

/** Splits "pricing, onboarding" from a form field. */
export const splitTagInput = (text: string): string[] => text.split(",");
