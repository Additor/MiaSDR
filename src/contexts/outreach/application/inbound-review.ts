import { isOwnerOrAdmin } from "@/contexts/tenancy/domain/roles";
import { ConflictError, ForbiddenError, NotFoundError, type Actor } from "@/shared/errors";

export type InboundSource = "gmail" | "linkedin";

/**
 * Where a failed inbound event stands.
 * dead: gave up (5 Gmail attempts, 8 LinkedIn attempts). Needs a person.
 * retrying: failed, and the sync or replay job will try again by itself.
 * queued: a person asked for a retry that has not run yet.
 * dismissed: a person marked it ignored.
 * closed: not a failure (done, in flight or a normal skip). Never listed.
 */
export type InboundEventState = "dead" | "retrying" | "queued" | "dismissed" | "closed";

export type InboundStateFilter = "open" | "dead" | "retrying" | "queued" | "dismissed" | "all";

export interface InboundEventSummary {
  id: string;
  source: InboundSource;
  /** Mailbox address (Gmail) or provider account id (LinkedIn). */
  accountRef: string | null;
  eventType: string;
  state: Exclude<InboundEventState, "closed">;
  attempts: number;
  /** Last error line, cut to 300 characters. */
  error: string | null;
  /** Sender and subject for Gmail. Never the message body. */
  subject: string | null;
  from: string | null;
  createdAt: Date;
  lastAttemptAt: Date | null;
  dismissedAt: Date | null;
  dismissedBy: string | null;
}

export interface InboundEventListQuery {
  source: InboundSource | "all";
  state: InboundStateFilter;
  limit: number;
  offset: number;
}

export interface InboundReviewStore {
  list(organizationId: string, query: InboundEventListQuery): Promise<{ rows: InboundEventSummary[]; total: number }>;
  /** The state of one event of this organization, or null when it does not exist there. */
  getState(organizationId: string, id: string): Promise<InboundEventState | null>;
  /**
   * Puts a dead or dismissed event back in line: Gmail rows become `pending` with zero attempts (the next sync
   * fetches the message again), LinkedIn rows become `failed` with zero attempts and a due time (the replay job
   * claims them). Returns false when the event was not in such a state.
   */
  requestRetry(organizationId: string, id: string, now: Date): Promise<boolean>;
  /** Marks a dead, retrying or queued event ignored, with who and when. Returns false when it was not in such a state. */
  dismiss(organizationId: string, id: string, userId: string, now: Date): Promise<boolean>;
}

export interface InboundReviewDeps {
  store: InboundReviewStore;
  now: () => Date;
}

const MAX_PAGE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireAdmin(actor: Actor) {
  if (!isOwnerOrAdmin(actor.role)) throw new ForbiddenError("Only an owner or admin can review failed inbound events.");
}

export async function listInboundEvents(deps: InboundReviewDeps, actor: Actor, query: Partial<InboundEventListQuery> = {}) {
  requireAdmin(actor);
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 25), 1), MAX_PAGE);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const result = await deps.store.list(actor.organizationId, { source: query.source ?? "all", state: query.state ?? "open", limit, offset });
  return { ...result, limit, offset };
}

/** Queues a dead or dismissed event for another attempt. Asking twice is fine. An event of another organization answers 404. */
export async function retryInboundEvent(deps: InboundReviewDeps, actor: Actor, id: string): Promise<{ state: "queued" }> {
  requireAdmin(actor);
  const state = UUID.test(id) ? await deps.store.getState(actor.organizationId, id) : null;
  if (state === null) throw new NotFoundError("Inbound event not found.");
  if (state === "queued") return { state };
  if (state === "retrying") throw new ConflictError("This event is still being retried automatically.");
  if (state === "closed") throw new ConflictError("This event was already processed.");
  if (!(await deps.store.requestRetry(actor.organizationId, id, deps.now()))) {
    // Another request changed it between the read and the write. Report what is true now.
    if ((await deps.store.getState(actor.organizationId, id)) === "queued") return { state: "queued" };
    throw new ConflictError("This event can no longer be retried.");
  }
  return { state: "queued" };
}

/** Marks an event ignored. Dismissing twice is fine. An event of another organization answers 404. */
export async function dismissInboundEvent(deps: InboundReviewDeps, actor: Actor, id: string): Promise<{ state: "dismissed" }> {
  requireAdmin(actor);
  const state = UUID.test(id) ? await deps.store.getState(actor.organizationId, id) : null;
  if (state === null) throw new NotFoundError("Inbound event not found.");
  if (state === "dismissed") return { state };
  if (state === "closed") throw new ConflictError("This event was already processed.");
  if (!(await deps.store.dismiss(actor.organizationId, id, actor.userId, deps.now()))) {
    if ((await deps.store.getState(actor.organizationId, id)) === "dismissed") return { state: "dismissed" };
    throw new ConflictError("This event can no longer be dismissed.");
  }
  return { state: "dismissed" };
}
