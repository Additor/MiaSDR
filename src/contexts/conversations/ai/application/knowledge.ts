import { KNOWLEDGE_KINDS, parseTags } from "../domain/knowledge";
import { ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";

/**
 * Pasted-text knowledge documents that drafts may draw on. Any member reads them; only an owner or admin adds or changes one.
 * Every content edit stores a new version, so a draft's citations keep
 * pointing at the text the model saw.
 */

export interface KnowledgeDoc {
  id: string;
  title: string;
  kind: string;
  alwaysInclude: boolean;
  tags: string[];
  active: boolean;
  version: number;
  content: string;
  updatedAt: Date;
}

export interface KnowledgeInput {
  title: string;
  kind: string;
  content: string;
  alwaysInclude: boolean;
  /** Lowercased, unique, at most 50 of up to 80 characters. Empty when omitted. */
  tags?: string[];
}

export interface KnowledgeStore {
  list(organizationId: string): Promise<KnowledgeDoc[]>;
  create(organizationId: string, input: KnowledgeInput): Promise<{ id: string }>;
  /** Adds a version when the content changed. Returns false when the document does not exist in the organization. */
  update(organizationId: string, id: string, input: Partial<KnowledgeInput> & { active?: boolean }): Promise<boolean>;
}

const MAX_CONTENT = 50_000;

function clean(input: Partial<KnowledgeInput>) {
  const out: Partial<KnowledgeInput> = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title === "" || title.length > 200) throw new ValidationError("The title must be 1 to 200 characters.");
    out.title = title;
  }
  if (input.kind !== undefined) {
    if (!(KNOWLEDGE_KINDS as readonly string[]).includes(input.kind)) throw new ValidationError("Unknown document kind.");
    out.kind = input.kind;
  }
  if (input.content !== undefined) {
    const content = input.content.trim();
    if (content === "" || content.length > MAX_CONTENT) throw new ValidationError(`The text must be 1 to ${MAX_CONTENT} characters.`);
    out.content = content;
  }
  if (input.alwaysInclude !== undefined) out.alwaysInclude = input.alwaysInclude;
  if (input.tags !== undefined) {
    const parsed = parseTags(input.tags);
    if (parsed.problem !== null) throw new ValidationError(parsed.problem);
    out.tags = parsed.tags;
  }
  return out;
}

function requireAdmin(actor: Actor): void {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can change knowledge documents.");
}

export const listKnowledge = (store: KnowledgeStore, actor: Actor) => store.list(actor.organizationId);

export async function createKnowledge(store: KnowledgeStore, actor: Actor, input: KnowledgeInput) {
  requireAdmin(actor);
  const checked = clean(input) as KnowledgeInput;
  if (!checked.title || !checked.kind || !checked.content) throw new ValidationError("Title, kind and text are required.");
  return store.create(actor.organizationId, { ...checked, alwaysInclude: input.alwaysInclude, tags: checked.tags ?? [] });
}

export async function updateKnowledge(store: KnowledgeStore, actor: Actor, id: string, input: Partial<KnowledgeInput> & { active?: boolean }) {
  requireAdmin(actor);
  const ok = await store.update(actor.organizationId, id, { ...clean(input), ...(input.active === undefined ? {} : { active: input.active }) });
  if (!ok) throw new NotFoundError("Document not found");
}
