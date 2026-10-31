import { and, count, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db, inTransaction, type DbHandle } from "@/platform/db/client";
import { campaignEnrollments, campaignSenders, campaigns, channelSettings, linkedinAccounts, mailboxes } from "@/platform/db/schema";
import { readAgentSendGate } from "@/contexts/tenancy/infrastructure/mcp-policy-reader";
import { isOutboundPaused } from "@/shared/outbound-pause";
import type { AgentCampaignStore, AgentCampaignRow, AgentSender } from "../application/agent-campaigns";
import { readSendPause } from "../domain/send-pause";

async function lockCampaign(tx: DbHandle, organizationId: string, campaignId: string, mode: "update" | "share"): Promise<AgentCampaignRow | null> {
  const [row] = await tx
    .select({ id: campaigns.id, channel: campaigns.channel, type: campaigns.type, status: campaigns.status, steps: campaigns.steps, archivedAt: campaigns.archivedAt })
    .from(campaigns)
    .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, campaignId)))
    .for(mode);
  return row ? { ...row, channel: row.channel as AgentCampaignRow["channel"] } : null;
}

/**
 * The agent side of campaign starts and enrolls (docs/database.md, "Lock modes"). A start or resume locks the campaign
 * `FOR UPDATE` and takes `agent-send` shared; an enroll locks it `FOR SHARE`, takes `agent-send` shared and then the
 * organization's `agent-enroll` lock exclusive, so two agent enrolls count the daily limit one after the other.
 */
export const drizzleAgentCampaignStore: AgentCampaignStore = {
  transaction: (fn, within) => inTransaction(within, fn),

  snapshot(organizationId, campaignId, fn) {
    // One snapshot for the token and the checks a preview reports, so both describe the same moment.
    return db.transaction((tx) => fn(tx), { isolationLevel: "repeatable read", accessMode: "read only" });
  },

  async campaign(tx, organizationId, campaignId) {
    const [row] = await tx
      .select({ id: campaigns.id, channel: campaigns.channel, type: campaigns.type, status: campaigns.status, steps: campaigns.steps, archivedAt: campaigns.archivedAt })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.id, campaignId)));
    return row ? { ...row, channel: row.channel as AgentCampaignRow["channel"] } : null;
  },

  lockForStart: (tx, organizationId, campaignId) => lockCampaign(tx, organizationId, campaignId, "update"),

  lockForEnroll: (tx, organizationId, campaignId) => lockCampaign(tx, organizationId, campaignId, "share"),

  async gate(tx, organizationId, tokenId, now) {
    const { policy, settings } = await readAgentSendGate(tx, { organizationId, tokenId, lock: "shared", now });
    return { campaigns: policy.campaigns, enrollCap: settings.agentEnrollCap };
  },

  async lockAgentEnroll(tx, organizationId) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agent-enroll:${organizationId}`}, 0))`);
  },

  async senders(tx, organizationId, campaign) {
    if (campaign.channel === "email") {
      const assigned = await tx
        .select({ id: mailboxes.id, status: mailboxes.status, name: mailboxes.emailAddress })
        .from(campaignSenders)
        .innerJoin(mailboxes, eq(mailboxes.id, campaignSenders.mailboxId))
        .where(eq(campaignSenders.campaignId, campaign.id));
      const rows = assigned.length > 0 ? assigned : await tx.select({ id: mailboxes.id, status: mailboxes.status, name: mailboxes.emailAddress }).from(mailboxes).where(eq(mailboxes.organizationId, organizationId));
      return { assigned: assigned.length > 0, senders: rows.map((r): AgentSender => ({ ...r, ownerUserId: null, dailyLimit: null, limitReachedUntil: null })) };
    }
    const columns = {
      id: linkedinAccounts.id,
      status: linkedinAccounts.status,
      name: sql<string>`coalesce(${linkedinAccounts.name}, ${linkedinAccounts.username}, 'LinkedIn account')`,
      ownerUserId: linkedinAccounts.ownerUserId,
      dailyLimit: linkedinAccounts.dailyInviteLimit,
      limitReachedUntil: linkedinAccounts.limitReachedUntil,
    };
    const assigned = await tx.select(columns).from(campaignSenders).innerJoin(linkedinAccounts, eq(linkedinAccounts.id, campaignSenders.linkedinAccountId)).where(eq(campaignSenders.campaignId, campaign.id));
    const rows = assigned.length > 0 ? assigned : await tx.select(columns).from(linkedinAccounts).where(eq(linkedinAccounts.organizationId, organizationId));
    return { assigned: assigned.length > 0, senders: rows };
  },

  async pending(tx, campaignId) {
    const [row] = await tx
      .select({ n: count() })
      .from(campaignEnrollments)
      .where(and(eq(campaignEnrollments.campaignId, campaignId), inArray(campaignEnrollments.status, ["pending"])));
    return row.n;
  },

  async sendPaused(tx, organizationId) {
    if (isOutboundPaused()) return true;
    const [general] = await tx
      .select({ values: channelSettings.values })
      .from(channelSettings)
      .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, "general")));
    return readSendPause(general?.values) !== null;
  },

  async agentEnrolledSince(tx, organizationId, since) {
    const [row] = await tx
      .select({ n: count() })
      .from(campaignEnrollments)
      .where(and(eq(campaignEnrollments.organizationId, organizationId), isNotNull(campaignEnrollments.enrolledViaTokenId), gte(campaignEnrollments.createdAt, since)));
    return row.n;
  },

  async agentStartedActive(organizationId) {
    const rows = await db
      .select({ id: campaigns.id, channel: campaigns.channel })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.status, "active"), isNotNull(campaigns.startedViaTokenId)));
    return rows.map((r) => ({ id: r.id, channel: r.channel as "email" | "linkedin" }));
  },

  async markEnrolledVia(tx, campaignId, tokenId) {
    // Rows this transaction inserted carry its start time, `now()`, as their creation time.
    const rows = await tx
      .update(campaignEnrollments)
      .set({ enrolledViaTokenId: tokenId })
      .where(and(eq(campaignEnrollments.campaignId, campaignId), sql`${campaignEnrollments.createdAt} = now()`, sql`${campaignEnrollments.enrolledViaTokenId} is null`))
      .returning({ id: campaignEnrollments.id });
    return rows.length;
  },

};
