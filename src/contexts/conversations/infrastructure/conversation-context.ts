import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { DbTx } from "@/platform/db/client";
import { sqlValues } from "@/platform/db/sql-values";
import { interruptConversationRunsTx } from "../after-reply/infrastructure/follow-up-stop";
import { PICK_FROM } from "../domain/reply-type-pick";
import { conversations } from "./schema";
import { staleOpenDraftsTx } from "./stale-drafts-sql";

/**
 * The one writer of `conversations.context_version` (`src/architecture/conversation-context-writer.test.ts`). A bump says what the
 * conversation's work was prepared for has changed, so everything that hangs on the old version ends in the same transaction:
 *
 * 1. The new version goes in with the caller's other conversation columns (`set`), so a job that read the old one skips.
 * 2. An AI pick held for a check retires (`stale`): it can no longer be accepted, so the history, the reply counts and the
 *    draft prompt stop treating it as waiting. A stop request it read stays open whatever the pick's status: the flag stays on
 *    the row and only a person's review answers it (`stopReviewOpenSql`).
 * 3. With `drafts`, open drafts retire with that reason. With `runs`, the conversation's sequence run ends with that reason.
 *
 * The caller holds the conversation's lock when the path needs one, and writes its event with the returned version.
 */
export interface AdvanceConversationContext {
  organizationId: string;
  conversationId: string;
  now: Date;
  set?: PgUpdateSetSource<typeof conversations>;
  drafts?: { reason: string } | null;
  runs?: Parameters<typeof interruptConversationRunsTx>[3] | null;
}

export async function advanceConversationContextTx(tx: DbTx, input: AdvanceConversationContext): Promise<{ contextVersion: number; draftsRetired: number; runsEnded: number }> {
  const { organizationId, conversationId, now } = input;
  const [bumped] = await tx
    .update(conversations)
    .set({ ...input.set, contextVersion: sql`${conversations.contextVersion} + 1` })
    .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)))
    .returning({ contextVersion: conversations.contextVersion });
  await tx.execute(sql`
    update reply_type_picks k set status = 'stale'
    where k.organization_id = ${organizationId} and k.conversation_id = ${conversationId} and k.status in ${sqlValues(PICK_FROM.stale)}`);
  const draftsRetired = input.drafts ? await staleOpenDraftsTx(tx, { organizationId, conversationId, reason: input.drafts.reason, now }) : 0;
  const runsEnded = input.runs ? await interruptConversationRunsTx(tx, organizationId, conversationId, input.runs, now) : 0;
  return { contextVersion: bumped.contextVersion, draftsRetired, runsEnded };
}

/**
 * A genuine reply landed on the conversation, on either channel. The conversation asks for action, the newest message becomes the
 * latest reply, and a draft written before it turns stale: it answers an older state of the thread, and send would refuse
 * it anyway.
 */
export async function recordInboundTx(tx: DbTx, input: { organizationId: string; conversationId: string; channel: "email" | "linkedin"; messageId: string; at: SQL; now: Date }): Promise<void> {
  const newest = sql`${conversations.lastInboundAt} is null or ${conversations.lastInboundAt} <= ${input.at}`;
  await advanceConversationContextTx(tx, {
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    now: input.now,
    set: {
      workflowState: "action_required",
      closedReason: null,
      activeChannel: input.channel,
      latestInboundMessageId: sql`case when ${newest} then ${input.messageId}::uuid else ${conversations.latestInboundMessageId} end`,
      lastInboundAt: sql`greatest(coalesce(${conversations.lastInboundAt}, ${input.at}), ${input.at})`,
      lastInteractionAt: sql`greatest(coalesce(${conversations.lastInteractionAt}, ${input.at}), ${input.at})`,
    },
    drafts: { reason: "A newer message arrived after this draft was written." },
  });
}
