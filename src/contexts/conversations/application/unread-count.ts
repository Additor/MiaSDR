import type { Actor } from "@/shared/errors";

export interface UnreadCounts {
  total: number;
  linkedin: number;
  email: number;
}

export interface UnreadStore {
  /** Inbound messages nobody opened yet, auto-replies excluded, in the organization's conversations. */
  counts(organizationId: string): Promise<UnreadCounts>;
}

export function unreadCounts(store: UnreadStore, actor: Actor): Promise<UnreadCounts> {
  return store.counts(actor.organizationId);
}
