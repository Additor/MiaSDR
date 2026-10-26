import type { QueueCursor, QueueFilter, QueueGroup, QueueProblemKind, QueueScope, WaitingSince } from "../domain/action-queue";

/** The work queue: what waits on a person, as the Actions page, the badges and the API read it. Every method carries the organization and filters by it. */

export interface QueueItem {
  recordId: string;
  personId: string;
  group: QueueGroup;
  personName: string | null;
  personLifecycle: "lead" | "contact";
  /** The thread to open. Null when the record has no public conversation. */
  conversationId: string | null;
  groupKey: string | null;
  replyTypeName: string | null;
  channel: string | null;
  workflowState: string;
  /** Who handles the replies, or null while nobody does. */
  assignee: { id: string; name: string | null } | null;
  nextActionAt: Date | null;
  /** The start of the latest message the other side sent in the thread this item opens, on one line. Null when the thread holds none. */
  snippet: string | null;
  /** When the item started to wait, and why. A group lists its items by it, oldest first. */
  waitingSince: WaitingSince;
  /** `preview` is the start of the draft's current text on one line, read for the rows of a page only. */
  draft: { draftId: string; status: string; subject: string | null; updatedAt: Date; preview: string | null } | null;
  /** `contextVersion` is the record version the suggestion was written for: accepting a held one sends it back. */
  classification: { replyTypePickId: string; kind: "held" | "changed"; groupKey: string | null; name: string | null; confidence: number | null; contextVersion: number } | null;
  problem: { kind: QueueProblemKind; message: string } | null;
}

export interface QueueGroupPage {
  /** Every record in the group under the filter, not only this page. */
  total: number;
  items: QueueItem[];
  /** Pass it back with the same filter and the group to load the next page. Null on the last page. */
  nextCursor: string | null;
}

export interface ActionQueue {
  groups: Record<QueueGroup, QueueGroupPage>;
  /** Sum of the group totals under the filter. */
  total: number;
}

/** The unfiltered queue size, from the same query as the list. Feeds the badges. */
export interface ActionQueueCounts {
  /** Records in the queue, all scopes. */
  total: number;
  byGroup: Record<QueueGroup, number>;
  /** Records by scope. The three add up to `total`. */
  byScope: Record<QueueScope, number>;
  /** Open tasks by scope: assigned to me, to nobody, to someone else. A task on a record that is not shown is left out. */
  tasks: Record<QueueScope, number>;
  /** Records and tasks together. A `next_step` record with an open task is in the queue's task count only, so nothing counts twice. `work.mine` is the sidebar number. */
  work: Record<QueueScope, number>;
  /** Per scope, the earliest waiting time over replies, classifications, next steps and problems. Follow-ups are left out. Null when none waits. */
  oldestWaiting: Record<QueueScope, Date | null>;
}

/** Work that has no record: campaign sends the provider never confirmed, and inbound mail waiting for an identity decision. */
export interface ActionQueueExtras {
  uncertainCampaignSends: Array<{ sendId: string; campaignId: string; campaignName: string; channel: string; personName: string | null; claimedAt: Date }>;
  openIdentityExceptions: number;
}

/** Where a record stands in the queue under a filter: its group and the cursor that continues the group after it. */
export interface QueuePosition {
  group: QueueGroup;
  cursor: QueueCursor;
}

export interface WorkQueueStore {
  /** One page of every group, or of `filter.group` when `cursor` is set. */
  actionQueue(organizationId: string, input: { actorUserId: string; filter: QueueFilter; limit: number; cursor: QueueCursor | null }): Promise<ActionQueue>;
  /** `actorUserId` is the person "mine" means. */
  actionQueueCounts(organizationId: string, actorUserId: string): Promise<ActionQueueCounts>;
  actionQueueExtras(organizationId: string): Promise<ActionQueueExtras>;
  /** Null when the record is not in the queue under the filter, for instance because it was just handled. */
  queuePosition(organizationId: string, input: { actorUserId: string; filter: QueueFilter; recordId: string }): Promise<QueuePosition | null>;
}
