import { NotFoundError, type Actor } from "@/shared/errors";
import { resolveDateRange, type InboxParams } from "../domain/inbox-filter";
import type { InboxFilter, InboxStore } from "./ports";

export interface InboxDeps {
  store: InboxStore;
  now: () => Date;
  /** The organization's time zone. The date filters read their days in it; UTC when this is not wired. */
  timeZone?: (organizationId: string) => Promise<string>;
}

export const INBOX_PAGE_SIZE = 25;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function toFilter(deps: InboxDeps, organizationId: string, input: Partial<InboxParams>): Promise<InboxFilter> {
  // The zone is read only when a date filter needs it.
  const zone = input.dateMode && input.dateMode !== "all" && deps.timeZone ? await deps.timeZone(organizationId) : "UTC";
  const range = resolveDateRange({ mode: input.dateMode, from: input.dateFrom, to: input.dateTo }, deps.now(), zone);
  return {
    query: input.query?.trim().slice(0, 200) || undefined,
    view: input.view ?? "all",
    page: Math.max(1, Math.floor(input.page ?? 1)),
    pageSize: INBOX_PAGE_SIZE,
    leadIds: input.leadIds,
    leadQuery: input.leadQuery?.trim().slice(0, 200) || undefined,
    campaignIds: input.campaignIds,
    mailboxIds: input.mailboxIds,
    subcategoryKeys: input.subcategoryKeys,
    categoryKeys: input.categoryKeys,
    from: range.start,
    to: range.end,
  };
}

export async function listInbox(deps: InboxDeps, actor: Actor, input: Partial<InboxParams>) {
  return deps.store.list(actor.organizationId, await toFilter(deps, actor.organizationId, input));
}

export async function listScheduledInbox(deps: InboxDeps, actor: Actor, input: Partial<InboxParams>) {
  return deps.store.listScheduled(actor.organizationId, await toFilter(deps, actor.organizationId, input));
}

export function inboxFilterOptions(deps: InboxDeps, actor: Actor, leadIds: string[]) {
  return deps.store.filterOptions(actor.organizationId, leadIds);
}

export async function getThread(deps: InboxDeps, actor: Actor, conversationId: string) {
  if (!UUID.test(conversationId)) throw new NotFoundError("Conversation not found");
  const thread = await deps.store.thread(actor.organizationId, conversationId);
  if (!thread) throw new NotFoundError("Conversation not found");
  return thread;
}

export async function markConversationRead(deps: InboxDeps, actor: Actor, conversationId: string): Promise<{ changed: number }> {
  if (!UUID.test(conversationId)) throw new NotFoundError("Conversation not found");
  const changed = await deps.store.markRead(actor.organizationId, conversationId, deps.now());
  if (changed === null) throw new NotFoundError("Conversation not found");
  return { changed };
}
