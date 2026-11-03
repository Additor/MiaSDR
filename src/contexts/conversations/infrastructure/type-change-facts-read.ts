import { and, eq } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { records, replyTypes } from "@/platform/db/schema";
import { replyAskedToStop } from "./stop-requested-sql";
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
 * The facts `typeChangeOutcome` reads for one record: its current type, the types of its set, whether the latest
 * reply asked to stop (`replyAskedToStop`), whether the person is a contact, and the Follow-ups after a reply mode
 * and channel that decide whether follow-ups apply. Null for a record outside the organization. The Change type outcomes read it; a write decides through `personTypeDecisionTx`.
 */
export async function typeChangeFactsOf(organizationId: string, recordId: string, exec: DbHandle = db): Promise<TypeChangeFacts | null> {
  const [head] = await exec
    .select({ record: records })
    .from(records)
    .where(and(eq(records.id, recordId), eq(records.organizationId, organizationId)));
  if (!head) return null;
  const { record } = head;

  const [types, stopRequested, mode] = await Promise.all([
    exec.select().from(replyTypes).where(and(eq(replyTypes.organizationId, organizationId), eq(replyTypes.replyTypeSetId, record.replyTypeSetId))),
    replyAskedToStop(exec, record.latestInboundMessageId),
    followUpModeFactsTx(exec, organizationId, recordId),
  ]);
  const current = types.find((t) => t.id === record.replyTypeId);

  return {
    current: current ? replyTypeOption(current) : null,
    targets: types.sort(byGroupThenOrder).map(replyTypeOption),
    facts: {
      stopRequested,
      isContact: mode?.isContact ?? false,
      campaignMode: mode?.campaignMode ?? null,
      channel: mode?.channel ?? record.activeChannel,
      locked: record.replyTypeLocked,
    },
  };
}
