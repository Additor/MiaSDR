import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { campaignEnrollments, channelSettings, drafts, mailboxes, mcpTokens, conversations, sendAttempts, sends } from "@/platform/db/schema";
import { readSendPause } from "@/contexts/outreach/domain/send-pause";
import { readAgentSendGate } from "@/contexts/tenancy/infrastructure/mcp-policy-reader";
import type { AgentVia } from "@/shared/errors";
import { isOutboundPaused } from "@/shared/outbound-pause";
import { ATTEMPT_COUNTED } from "../domain/send-attempt-status";
import { replyRefusal, type AgentReplyRefusal, type ReplyChannel } from "../domain/reply-send";
import { utcDayStart } from "@/shared/utc-day";
import { stopReviewOpen } from "../stopping/infrastructure/stop-requested-sql";

/** How long an agent waits between two replies in one reply handling, on either channel. */
export const AGENT_REPLY_GAP_MS = 24 * 60 * 60 * 1000;

export interface AgentReplyCheck {
  organizationId: string;
  via: AgentVia;
  /** The token's person: the per-person limit counts their agent sends. */
  actorUserId: string;
  channel: ReplyChannel;
  threadId: string;
  conversationId: string;
  /** The conversation's person now. A campaign must have reached this same person. */
  personId: string;
  /** The conversation's provider thread: the email thread id, or the LinkedIn chat. */
  providerThreadId: string | null;
  /** The conversation's account: the mailbox address in lowercase, or the LinkedIn account id. */
  accountRef: string;
  cc: readonly string[];
  now: Date;
}

const refuse = (reason: AgentReplyRefusal, channel: ReplyChannel, retryAfterSeconds?: number) =>
  replyRefusal(reason, channel, {}, retryAfterSeconds === undefined ? undefined : { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) });

/**
 * A campaign reached this person in this conversation, or a person in the organization already replied in it. A
 * stranger who writes to a mailbox or LinkedIn account, a lead who was enrolled but never sent to, and a thread whose
 * person changed in a merge all fail, so an agent never opens a conversation with someone new.
 */
async function recipientVerified(tx: DbTx, input: AgentReplyCheck): Promise<boolean> {
  const [byPerson] = await tx
    .select({ id: sendAttempts.id })
    .from(sendAttempts)
    .innerJoin(drafts, eq(drafts.id, sendAttempts.draftId))
    .where(and(eq(drafts.threadId, input.threadId), eq(sendAttempts.origin, "person"), inArray(sendAttempts.status, ["sent", "reconciled"])))
    .limit(1);
  if (byPerson) return true;
  const reached = and(eq(sends.organizationId, input.organizationId), eq(sends.kind, "campaign"), eq(sends.status, "sent"), eq(campaignEnrollments.personId, input.personId));
  if (input.channel === "email") {
    if (!input.providerThreadId) return false;
    const [campaign] = await tx
      .select({ id: sends.id })
      .from(sends)
      .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
      .innerJoin(mailboxes, eq(mailboxes.id, sends.mailboxId))
      .where(and(reached, eq(sends.providerThreadId, input.providerThreadId), sql`lower(${mailboxes.emailAddress}) = ${input.accountRef}`))
      .limit(1);
    return Boolean(campaign);
  }
  const [campaign] = await tx
    .select({ id: sends.id })
    .from(sends)
    .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
    .where(and(reached, sql`${sends.linkedinAccountId}::text = ${input.accountRef}`))
    .limit(1);
  return Boolean(campaign);
}

/**
 * The agent rules of docs/decisions.md, "Agent sends", run inside a send's transaction after the person's rules and
 * the draft lock, in the order the table lists them. The first one that fails throws its `agent_*` refusal.
 */
export async function checkAgentReply(tx: DbTx, input: AgentReplyCheck): Promise<void> {
  const { channel, now } = input;
  const { policy, settings } = await readAgentSendGate(tx, { organizationId: input.organizationId, tokenId: input.via.tokenId, lock: "exclusive", now });
  if (!policy.replies) throw refuse("agent_send_off", channel);
  if (!(await recipientVerified(tx, input))) throw refuse("agent_unverified_recipient", channel);
  const [conversation] = await tx.select({ latest: conversations.latestInboundMessageId }).from(conversations).where(eq(conversations.id, input.conversationId));
  if (await stopReviewOpen(tx, conversation?.latest ?? null)) throw refuse("agent_stop_requested", channel);
  if (input.cc.length > 0) throw refuse("agent_cc_not_allowed", channel);

  const [general] = await tx
    .select({ values: channelSettings.values })
    .from(channelSettings)
    .where(and(eq(channelSettings.organizationId, input.organizationId), eq(channelSettings.channel, "general")));
  if (isOutboundPaused() || readSendPause(general?.values)) throw refuse("agent_send_paused", channel);

  // Counted after the agent-send lock, which every agent reply of the organization holds exclusive until it commits.
  const dayStart = utcDayStart(now);
  const counted = and(eq(sendAttempts.organizationId, input.organizationId), eq(sendAttempts.origin, "agent"), inArray(sendAttempts.status, [...ATTEMPT_COUNTED]), gte(sendAttempts.createdAt, dayStart));
  const [today] = await tx
    .select({
      org: sql<number>`count(*)::int`,
      user: sql<number>`(count(*) filter (where ${sendAttempts.actorUserId} = ${input.actorUserId}))::int`,
      mailbox: sql<number>`(count(*) filter (where ${sendAttempts.provider} = 'mailbox' and ${sendAttempts.accountRef} = ${input.accountRef}))::int`,
    })
    .from(sendAttempts)
    .where(counted);
  const caps = settings.agentReplyCaps;
  if (today.org >= caps.org || today.user >= caps.user || (channel === "email" && today.mailbox >= caps.mailbox)) {
    throw refuse("agent_daily_cap", channel, (dayStart.getTime() + 24 * 60 * 60 * 1000 - now.getTime()) / 1000);
  }

  const [last] = await tx
    .select({ at: sendAttempts.createdAt })
    .from(sendAttempts)
    .innerJoin(drafts, eq(drafts.id, sendAttempts.draftId))
    .where(
      and(
        eq(sendAttempts.organizationId, input.organizationId),
        eq(sendAttempts.origin, "agent"),
        inArray(sendAttempts.status, [...ATTEMPT_COUNTED]),
        eq(drafts.conversationId, input.conversationId),
        gte(sendAttempts.createdAt, new Date(now.getTime() - AGENT_REPLY_GAP_MS)),
      ),
    )
    .orderBy(desc(sendAttempts.createdAt))
    .limit(1);
  if (last) throw refuse("agent_reply_gap", channel, (last.at.getTime() + AGENT_REPLY_GAP_MS - now.getTime()) / 1000);
}

/** The agent behind a send attempt, with the token's name now, or undefined for a person's send. */
export async function attemptVia(tx: DbTx, attempt: { origin: string; mcpTokenId: string | null; clientName: string | null }): Promise<AgentVia | undefined> {
  if (attempt.origin !== "agent") return undefined;
  const [token] = attempt.mcpTokenId ? await tx.select({ name: mcpTokens.name }).from(mcpTokens).where(eq(mcpTokens.id, attempt.mcpTokenId)) : [];
  return { kind: "agent", tokenId: attempt.mcpTokenId ?? "", tokenName: token?.name ?? "a removed token", clientName: attempt.clientName };
}

/** The columns a send attempt stores about who sent it. */
export const attemptOrigin = (via: AgentVia | undefined) =>
  via ? { origin: "agent" as const, mcpTokenId: via.tokenId, clientName: via.clientName } : { origin: "person" as const };
