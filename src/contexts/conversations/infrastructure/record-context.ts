import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { DbTx } from "@/platform/db/client";
import { sqlValues } from "@/platform/db/sql-values";
import { interruptRecordRunsTx } from "../after-reply/infrastructure/sequence-stop";
import { PICK_FROM } from "../domain/reply-type-pick";
import { records } from "./schema";
import { staleOpenDraftsTx } from "./stale-drafts-sql";

/**
 * The one writer of `records.context_version` (`src/architecture/record-context-writer.test.ts`). A bump says what the
 * record's work was prepared for has changed, so everything that hangs on the old version ends in the same transaction:
 *
 * 1. The new version goes in with the caller's other record columns (`set`), so a job that read the old one skips.
 * 2. An AI pick held for a check retires (`stale`): it can no longer be accepted, so Actions, the history, the reply counts
 *    and the draft prompt stop treating it as waiting. A held pick of the latest reply that asks to stop stays until a person
 *    decides (`personDecided`), since the agent send gate reads it (`stopRequestOpen` in `agent-reply-gate.ts`).
 * 3. With `drafts`, open drafts retire with that reason. With `runs`, the record's sequence run ends with that reason.
 *
 * The caller holds the record's lock when the path needs one, and writes its event with the returned version.
 */
export interface AdvanceRecordContext {
  organizationId: string;
  recordId: string;
  now: Date;
  set?: PgUpdateSetSource<typeof records>;
  drafts?: { reason: string } | null;
  runs?: Parameters<typeof interruptRecordRunsTx>[3] | null;
  /** A person chose what the record is, which also answers a held stop request. */
  personDecided?: boolean;
}

export async function advanceRecordContextTx(tx: DbTx, input: AdvanceRecordContext): Promise<{ contextVersion: number; draftsRetired: number; runsEnded: number }> {
  const { organizationId, recordId, now } = input;
  const [bumped] = await tx
    .update(records)
    .set({ ...input.set, contextVersion: sql`${records.contextVersion} + 1` })
    .where(and(eq(records.id, recordId), eq(records.organizationId, organizationId)))
    .returning({ contextVersion: records.contextVersion });
  await tx.execute(sql`
    update reply_type_picks k set status = 'stale'
    where k.organization_id = ${organizationId} and k.record_id = ${recordId} and k.status in ${sqlValues(PICK_FROM.stale)}
      and (${input.personDecided === true}::boolean
        or k.message_id is distinct from (select r.latest_inbound_message_id from records r where r.id = ${recordId})
        or not (coalesce((k.response->>'stopRequested')::boolean, false)
          or exists (select 1 from reply_types t where t.id = k.proposed_reply_type_id and t.system_role = 'stop_request')))`);
  const draftsRetired = input.drafts ? await staleOpenDraftsTx(tx, { organizationId, recordId, reason: input.drafts.reason, now }) : 0;
  const runsEnded = input.runs ? await interruptRecordRunsTx(tx, organizationId, recordId, input.runs, now) : 0;
  return { contextVersion: bumped.contextVersion, draftsRetired, runsEnded };
}

/**
 * A genuine reply landed on the record, on either channel. The record asks for action, the newest message becomes the
 * latest reply, and a draft written before it turns stale: it answers an older state of the thread, and send would refuse
 * it anyway.
 */
export async function recordInboundTx(tx: DbTx, input: { organizationId: string; recordId: string; channel: "email" | "linkedin"; messageId: string; at: SQL; now: Date }): Promise<void> {
  const newest = sql`${records.lastInboundAt} is null or ${records.lastInboundAt} <= ${input.at}`;
  await advanceRecordContextTx(tx, {
    organizationId: input.organizationId,
    recordId: input.recordId,
    now: input.now,
    set: {
      workflowState: "action_required",
      activeChannel: input.channel,
      latestInboundMessageId: sql`case when ${newest} then ${input.messageId}::uuid else ${records.latestInboundMessageId} end`,
      lastInboundAt: sql`greatest(coalesce(${records.lastInboundAt}, ${input.at}), ${input.at})`,
      lastInteractionAt: sql`greatest(coalesce(${records.lastInteractionAt}, ${input.at}), ${input.at})`,
    },
    drafts: { reason: "A newer message arrived after this draft was written." },
  });
}
