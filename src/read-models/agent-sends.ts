import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/platform/db/client";
import { utcDayStart } from "@/shared/utc-day";
import { campaignEnrollments, campaigns, drafts, mcpTokens, sendAttempts, users } from "@/platform/db/schema";

/*
 * Agent sends: what agents sent and started in one organization, for Settings > MCP ("Read models" in
 * docs/decisions.md). Owners and admins read it; the page checks the role.
 */

export interface AgentSendRow {
  attemptId: string;
  conversationId: string;
  channel: "email" | "linkedin";
  status: string;
  tokenName: string;
  userName: string;
  createdAt: Date;
}

export interface AgentCampaignRow {
  campaignId: string;
  name: string;
  channel: string;
  status: string;
  tokenName: string;
  enrolledByAgents: number;
}

export interface AgentSendsOverview {
  sends: AgentSendRow[];
  campaigns: AgentCampaignRow[];
  /** Running campaigns an agent started, all of them: what Pause campaigns agents started would pause. */
  running: number;
  /** Today, from midnight UTC: what the daily limits count. */
  today: { replies: number; enrolls: number };
}

const SHOWN = 20;

export async function agentSendsOverview(organizationId: string, now: Date): Promise<AgentSendsOverview> {
  const dayStart = utcDayStart(now);
  const [sends, started, [running], [replies], [enrolls]] = await Promise.all([
    db
      .select({
        attemptId: sendAttempts.id,
        conversationId: drafts.conversationId,
        provider: sendAttempts.provider,
        status: sendAttempts.status,
        tokenName: sql<string>`coalesce(${mcpTokens.name}, 'a removed token')`,
        userName: users.name,
        createdAt: sendAttempts.createdAt,
      })
      .from(sendAttempts)
      .innerJoin(drafts, eq(drafts.id, sendAttempts.draftId))
      .innerJoin(users, eq(users.id, sendAttempts.actorUserId))
      .leftJoin(mcpTokens, eq(mcpTokens.id, sendAttempts.mcpTokenId))
      .where(and(eq(sendAttempts.organizationId, organizationId), eq(sendAttempts.origin, "agent")))
      .orderBy(desc(sendAttempts.createdAt))
      .limit(SHOWN),
    db
      .select({
        campaignId: campaigns.id,
        name: campaigns.name,
        channel: campaigns.channel,
        status: campaigns.status,
        tokenName: sql<string>`coalesce(${mcpTokens.name}, 'a removed token')`,
        enrolledByAgents: sql<number>`(select count(*)::int from ${campaignEnrollments} e where e.campaign_id = ${campaigns.id} and e.enrolled_via_token_id is not null)`,
      })
      .from(campaigns)
      .leftJoin(mcpTokens, eq(mcpTokens.id, campaigns.startedViaTokenId))
      .where(and(eq(campaigns.organizationId, organizationId), isNotNull(campaigns.startedViaTokenId)))
      .orderBy(desc(campaigns.updatedAt))
      .limit(SHOWN),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, organizationId), eq(campaigns.status, "active"), isNotNull(campaigns.startedViaTokenId))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(sendAttempts)
      .where(and(eq(sendAttempts.organizationId, organizationId), eq(sendAttempts.origin, "agent"), sql`${sendAttempts.status} <> 'failed'`, gte(sendAttempts.createdAt, dayStart))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(campaignEnrollments)
      .where(and(eq(campaignEnrollments.organizationId, organizationId), isNotNull(campaignEnrollments.enrolledViaTokenId), gte(campaignEnrollments.createdAt, dayStart))),
  ]);
  return {
    sends: sends.map(({ provider, ...row }): AgentSendRow => ({ ...row, channel: provider === "linkedin" ? "linkedin" : "email" })),
    campaigns: started,
    running: running?.n ?? 0,
    today: { replies: replies?.n ?? 0, enrolls: enrolls?.n ?? 0 },
  };
}
