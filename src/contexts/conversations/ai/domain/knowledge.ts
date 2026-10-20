export const KNOWLEDGE_KINDS = ["company", "product", "pricing", "faq", "case_study", "objection", "scheduling", "custom"] as const;

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

/** Prompt budget for knowledge: 2,000 tokens at 4 characters. */
export const KNOWLEDGE_BUDGET_CHARS = 8000;
/** One always-included document contributes at most this much, so a long one cannot starve the rest. */
export const ALWAYS_DOCUMENT_CHARS = 3000;
/** Always-included documents together take at most this much when other documents compete for the budget. */
export const ALWAYS_TOTAL_CHARS = 5000;
/** A document is not worth including when less than this much room is left. */
const MIN_ROOM_CHARS = 200;

export interface KnowledgeCandidate {
  documentVersionId: string;
  title: string;
  content: string;
  alwaysInclude: boolean;
  tags: readonly string[];
}

export interface SelectOptions {
  /** The step's `knowledgeTags`. Documents sharing more of them rank higher. */
  stepTags?: readonly string[];
  /** Include documents that match no step tag (and are not always-included), after the matching ones. */
  includeUnmatched: boolean;
  /** Only always-included documents compete, so they may use the whole budget. */
  alwaysOnly?: boolean;
  budgetChars?: number;
}

export interface PickedKnowledge {
  documentVersionId: string;
  title: string;
  content: string;
}

const cut = (content: string, room: number) => (content.length > room ? `${content.slice(0, room)}\n[truncated]` : content);

/**
 * Picks the documents for one prompt. Always-included documents go first, each capped, together capped, in title
 * order. The rest rank by how many step tags they share (more first, then title) and fill what is left. The result
 * never exceeds the budget by more than the truncation marker.
 */
export function selectKnowledge(candidates: readonly KnowledgeCandidate[], options: SelectOptions): PickedKnowledge[] {
  const budget = options.budgetChars ?? KNOWLEDGE_BUDGET_CHARS;
  const wanted = new Set(normalizeTags(options.stepTags ?? []));
  const byTitle = (a: KnowledgeCandidate, b: KnowledgeCandidate) => a.title.localeCompare(b.title);
  const overlap = (c: KnowledgeCandidate) => normalizeTags(c.tags).filter((t) => wanted.has(t)).length;

  const always = candidates.filter((c) => c.alwaysInclude).sort(byTitle);
  const others = candidates
    .filter((c) => !c.alwaysInclude && !options.alwaysOnly)
    .map((c) => ({ c, n: overlap(c) }))
    .filter((x) => x.n > 0 || options.includeUnmatched)
    .sort((a, b) => b.n - a.n || byTitle(a.c, b.c))
    .map((x) => x.c);

  const picked: PickedKnowledge[] = [];
  let used = 0;
  const alwaysTotal = options.alwaysOnly || others.length === 0 ? budget : Math.min(budget, ALWAYS_TOTAL_CHARS);
  let alwaysUsed = 0;
  for (const doc of always) {
    const room = Math.min(alwaysTotal - alwaysUsed, budget - used, ALWAYS_DOCUMENT_CHARS);
    if (room < MIN_ROOM_CHARS) break;
    const content = cut(doc.content, room);
    picked.push({ documentVersionId: doc.documentVersionId, title: doc.title, content });
    used += content.length;
    alwaysUsed += content.length;
  }
  for (const doc of others) {
    const room = budget - used;
    if (room < MIN_ROOM_CHARS) break;
    const content = cut(doc.content, room);
    picked.push({ documentVersionId: doc.documentVersionId, title: doc.title, content });
    used += content.length;
  }
  return picked;
}
