import { sql } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { publicConversationSql } from "@/platform/db/conversation-visibility";
import { rowsOf } from "@/platform/db/sql-values";
import { afterReplyLockedReason, afterReplyModeOf } from "../after-reply/domain/after-reply";
import { owningCampaignSql } from "../after-reply/infrastructure/after-reply-sql";
import type { CampaignMode, ReplyTypeFacts } from "../domain/reply-type";

/**
 * The facts of `decideReplyType` that decide whether follow-ups apply to a record, in one query: whether the person is a
 * contact, the After a reply mode of the campaign that owns the conversation (the one that emailed the person last
 * before the reply, as `loadStartOn` finds it) or the state that keeps it from starting runs, and the channel of the
 * latest reply. The AI apply path and a person's
 * type change both read them here, inside their transaction. Null for a record outside the organization.
 */
export async function followUpModeFactsTx(
  exec: DbHandle,
  organizationId: string,
  recordId: string,
): Promise<Pick<ReplyTypeFacts, "isContact" | "campaignMode" | "channel"> | null> {
  const [row] = rowsOf<{
    contact: boolean;
    channel: string | null;
    active_channel: string | null;
    owner_channel: string | null;
    owner_type: string | null;
    owner_status: string | null;
    owner_archived: boolean | null;
    flow_status: string | null;
    published: boolean;
  }>(
    await exec.execute(sql`
      select p.lifecycle = 'contact' as contact, r.active_channel,
             (select c.channel from messages m join conversations c on c.id = m.conversation_id
              where m.id = r.latest_inbound_message_id and c.organization_id = r.organization_id and ${publicConversationSql("c")}) as channel,
             own.channel as owner_channel, own.type as owner_type, own.status as owner_status, own.archived_at is not null as owner_archived, fl.status as flow_status,
             exists (select 1 from sequence_versions v where v.sequence_id = fl.id and v.status = 'published') as published
      from records r
      join people p on p.id = r.person_id and p.organization_id = r.organization_id
      left join lateral (${owningCampaignSql({
        organizationId: sql`r.organization_id`,
        personId: sql`r.person_id`,
        at: sql`coalesce(r.last_inbound_at, 'infinity'::timestamptz)`,
      })}) own on r.latest_inbound_message_id is not null
      left join sequences fl on fl.campaign_id = own.id and fl.organization_id = r.organization_id
      where r.id = ${recordId} and r.organization_id = ${organizationId}`),
  );
  if (!row) return null;
  const owner = row.owner_channel && row.owner_type ? { channel: row.owner_channel, type: row.owner_type } : null;
  // The same order as `startableCampaignSql` and `startBlockedReason`: a locked campaign is handoff, then the campaign
  // state, then the flow's mode.
  const campaignMode: CampaignMode = owner
    ? afterReplyLockedReason(owner)
      ? "handoff"
      : row.owner_archived
        ? "archived"
        : row.owner_status === "paused"
          ? "paused"
          : row.owner_status === "draft"
            ? "not_started"
            : afterReplyModeOf(row.flow_status ? { status: row.flow_status, hasPublishedVersion: row.published } : null)
    : null;
  return { isContact: row.contact, campaignMode, channel: row.channel ?? row.active_channel };
}
