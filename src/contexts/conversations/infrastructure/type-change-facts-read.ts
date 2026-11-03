import { and, eq } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { conversations, replyTypes } from "@/platform/db/schema";
import { replyAskedToStop } from "../stopping/infrastructure/stop-requested-sql";
import { followUpModeFactsTx } from "./follow-up-mode-facts";
import { byGroupThenOrder, type ReplyTypeGroup } from "../domain/reply-handling";
import { typeRulesOf } from "../domain/reply-type";
import type { ReplyTypeOption, TypeChangeFacts } from "../application/reply-handling-ports";

/** A reply type row as Change type reads it. */
export const replyTypeOption = (t: typeof replyTypes.$inferSelect): ReplyTypeOption => ({
  id: t.id,
  key: t.key,
  groupKey: t.groupKey as ReplyTypeGroup,
  name: t.name,
  systemRole: t.systemRole ?? null,
  rules: typeRulesOf(t),
});

/**
 * The facts `typeChangeOutcome` reads for one conversation: its current type, the types of its set, whether the latest
 * reply asked to stop (`replyAskedToStop`), whether the person is a contact, and the Follow-ups after a reply mode
 * and channel that decide whether follow-ups apply. Null for a conversation outside the organization. The Change type outcomes read it; a write decides through `personTypeDecisionTx`.
 */
export async function typeChangeFactsOf(organizationId: string, conversationId: string, exec: DbHandle = db): Promise<TypeChangeFacts | null> {
  const [head] = await exec
    .select({ conversation: conversations })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.organizationId, organizationId)));
  if (!head) return null;
  const { conversation } = head;

  const [types, stopRequested, mode] = await Promise.all([
    exec.select().from(replyTypes).where(and(eq(replyTypes.organizationId, organizationId), eq(replyTypes.replyTypeSetId, conversation.replyTypeSetId))),
    replyAskedToStop(exec, conversation.latestInboundMessageId),
    followUpModeFactsTx(exec, organizationId, conversationId),
  ]);
  const current = types.find((t) => t.id === conversation.replyTypeId);

  return {
    current: current ? replyTypeOption(current) : null,
    targets: types.sort(byGroupThenOrder).map(replyTypeOption),
    facts: {
      stopRequested,
      isContact: mode?.isContact ?? false,
      campaignMode: mode?.campaignMode ?? null,
      channel: mode?.channel ?? conversation.activeChannel,
      locked: conversation.replyTypeLocked,
    },
  };
}
