import { and, eq, sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { people, records, replyHandlingSettings, replyTypes } from "@/platform/db/schema";
import { rowsOf } from "@/platform/db/sql-values";
import { stopRequestedSql } from "./stop-requested-sql";
import { visibleRecordSql } from "@/platform/db/conversation-visibility";
import { afterReplyLockedReason, afterReplyModeOf } from "../after-reply/domain/after-reply";
import { loadStartOn } from "../after-reply/infrastructure/drizzle-sequence-store";
import { REPLY_TYPE_GROUPS, type ReplyTypeGroup } from "../domain/reply-handling";
import { typeRulesOf, type CampaignMode } from "../domain/reply-type";
import type { ReplyTypeOption, TypeChangeFacts } from "../application/reply-handling-ports";

const GROUP_ORDER = new Map<string, number>(REPLY_TYPE_GROUPS.map((c, i) => [c.key, i]));

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
 * The facts `typeChangeOutcome` reads for one record: its current type, the active types of its set, whether the latest
 * reply asked to stop (`stopRequestedSql`), whether the person is a contact, and the After a reply mode
 * and channel that decide whether follow-ups apply. Null for a record outside the organization or with only private
 * conversations. A write path passes its transaction, after it locked the record, so the facts match what it changes.
 */
export async function typeChangeFactsOf(organizationId: string, recordId: string, exec: DbHandle = db): Promise<TypeChangeFacts | null> {
  const [head] = await exec
    .select({ record: records, lifecycle: people.lifecycle })
    .from(records)
    .innerJoin(people, eq(people.id, records.personId))
    .where(and(eq(records.id, recordId), eq(records.organizationId, organizationId), visibleRecordSql("records")));
  if (!head) return null;
  const { record } = head;

  const [types, [settings], [stop], start] = await Promise.all([
    exec.select().from(replyTypes).where(and(eq(replyTypes.organizationId, organizationId), eq(replyTypes.replyTypeSetId, record.replyTypeSetId))),
    exec.select({ floor: replyHandlingSettings.autoApplyConfidence }).from(replyHandlingSettings).where(eq(replyHandlingSettings.replyTypeSetId, record.replyTypeSetId)),
    record.latestInboundMessageId
      ? exec.execute(sql`select ${stopRequestedSql(sql`${record.latestInboundMessageId}::uuid`)} as asked`).then((r) => rowsOf<{ asked: boolean }>(r))
      : Promise.resolve([]),
    loadStartOn(exec, organizationId, recordId, {}),
  ]);

  const owner = start?.owner ?? null;
  const campaignMode: CampaignMode = owner
    ? afterReplyLockedReason(owner)
      ? "handoff"
      : afterReplyModeOf(start?.flow ? { status: start.flow.status, hasPublishedVersion: start.flow.hasPublished } : null)
    : null;
  const current = types.find((t) => t.id === record.replyTypeId);

  return {
    current: current ? replyTypeOption(current) : null,
    targets: types
      .filter((t) => t.active)
      .sort((a, b) => (GROUP_ORDER.get(a.groupKey) ?? 9) - (GROUP_ORDER.get(b.groupKey) ?? 9) || a.sortOrder - b.sortOrder)
      .map(replyTypeOption),
    facts: {
      stopRequested: stop?.asked === true,
      isContact: head.lifecycle === "contact",
      campaignMode,
      channel: start?.conversation?.channel ?? record.activeChannel,
      floor: Number(settings?.floor ?? 0.85),
      locked: record.replyTypeLocked,
    },
  };
}
