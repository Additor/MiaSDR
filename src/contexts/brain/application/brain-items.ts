import { createBrainItem, reviseBrainItem, type BrainItemChange, type BrainItemInput, type BrainItemPatch, type BrainItemState, type NewBrainItem } from "../domain/brain-item";
import type { BrainFields } from "../domain/brain-fields";
import { BRAIN_GROUPS, type BrainGroup, type BrainKind } from "../domain/brain-kinds";
import { NotFoundError, type Actor } from "@/shared/errors";
import { isUuid } from "@/shared/uuid";

/**
 * Brain items: what an organization knows about itself and its market. Every member reads and changes them; each change
 * lands in the audit log, and every change to the fields stores a new version. A draft's stored request names the versions
 * the model saw.
 */

export const BRAIN_PAGE_SIZE = 50;

export type BrainView = "all" | BrainGroup | "needs_sorting";

export interface BrainItemRow {
  id: string;
  title: string;
  description: string | null;
  kind: BrainKind;
  tags: string[];
  alwaysInclude: boolean;
  active: boolean;
  version: number;
  /** A document from before the kinds existed. */
  legacy: boolean;
  updatedAt: Date;
}

export interface BrainItemDetail extends BrainItemRow {
  content: string;
  structuredData: BrainFields | null;
}

export interface BrainListFilter {
  kinds: readonly BrainKind[] | null;
  legacyOnly: boolean;
  q: string;
  active: boolean;
  limit: number;
  offset: number;
}

export interface BrainStore {
  list(organizationId: string, filter: BrainListFilter): Promise<{ rows: BrainItemRow[]; total: number }>;
  /** Active documents a person still has to sort. */
  countLegacy(organizationId: string): Promise<number>;
  hasActiveCompanyProfile(organizationId: string): Promise<boolean>;
  get(organizationId: string, id: string): Promise<BrainItemDetail | null>;
  create(organizationId: string, actorUserId: string, item: NewBrainItem): Promise<{ id: string }>;
  /** Locks the item and saves what `decide` returns. False when the item is not in the organization. */
  update(organizationId: string, actorUserId: string, id: string, decide: (current: BrainItemState) => BrainItemChange): Promise<boolean>;
}

export interface BrainListQuery {
  view: BrainView;
  q?: string;
  archived?: boolean;
  page?: number;
}

export async function listBrainItems(store: BrainStore, actor: Actor, query: BrainListQuery) {
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const filter: BrainListFilter = {
    kinds: query.view === "all" || query.view === "needs_sorting" ? null : BRAIN_GROUPS[query.view],
    legacyOnly: query.view === "needs_sorting",
    q: query.q?.trim() ?? "",
    active: !query.archived,
    limit: BRAIN_PAGE_SIZE,
    offset: (page - 1) * BRAIN_PAGE_SIZE,
  };
  const [{ rows, total }, needsSorting, hasCompanyProfile] = await Promise.all([store.list(actor.organizationId, filter), store.countLegacy(actor.organizationId), store.hasActiveCompanyProfile(actor.organizationId)]);
  return { rows, total, page, pageSize: BRAIN_PAGE_SIZE, needsSorting, hasCompanyProfile };
}

export async function getBrainItem(store: BrainStore, actor: Actor, id: string): Promise<BrainItemDetail> {
  const item = isUuid(id) ? await store.get(actor.organizationId, id) : null;
  if (!item) throw new NotFoundError("Item not found");
  return item;
}

export const addBrainItem = (store: BrainStore, actor: Actor, input: BrainItemInput) => store.create(actor.organizationId, actor.userId, createBrainItem(input));

export async function changeBrainItem(store: BrainStore, actor: Actor, id: string, patch: BrainItemPatch): Promise<void> {
  const found = await store.update(actor.organizationId, actor.userId, id, (current) => reviseBrainItem(current, patch));
  if (!found) throw new NotFoundError("Item not found");
}

export const brainHasActiveCompanyProfile = (store: BrainStore, actor: Actor) => store.hasActiveCompanyProfile(actor.organizationId);
