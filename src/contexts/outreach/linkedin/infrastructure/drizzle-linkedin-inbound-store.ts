import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import { campaignEnrollments, campaigns, inboundEvents, linkedinAccounts, linkedinConnections, linkedinEnrollmentDetails, people } from "@/platform/db/schema";
import type { InboxFiling } from "../../application/inbound-ports";
import type { InboundResult, LedgerEvent, LinkedInInboundStore } from "../application/linkedin-ports";
import { MAX_EVENT_ATTEMPTS, linkedinSlug, type LinkedInInboundEvent } from "../domain/linkedin";
import { applyAcceptance } from "./drizzle-linkedin-store";
import { LIVE_ENROLLMENT_STATUSES } from "../../domain/enrollment-status";

type Tx = DbTx;

const LEASE_SECONDS = 300;

const logLine = (level: string, message: string, now: Date) => sql`${inboundEvents.log} || ${JSON.stringify([{ ts: now.toISOString(), level, message }])}::jsonb`;

const toLedger = (r: { id: string; organizationId: string | null; payload: unknown; attempts: number }): LedgerEvent => ({
  id: r.id,
  organizationId: r.organizationId,
  payload: r.payload,
  attempts: r.attempts,
});

/** Enrollments of this member on this account that still wait for an acceptance. */
async function waitingForAcceptance(tx: Tx, organizationId: string, accountId: string, member: string) {
  return tx
    .select({ id: campaignEnrollments.id, steps: campaigns.steps })
    .from(campaignEnrollments)
    .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
    .innerJoin(linkedinEnrollmentDetails, eq(linkedinEnrollmentDetails.enrollmentId, campaignEnrollments.id))
    .where(
      and(
        eq(campaignEnrollments.organizationId, organizationId),
        eq(campaignEnrollments.linkedinAccountId, accountId),
        eq(linkedinEnrollmentDetails.providerId, member),
        sql`${linkedinEnrollmentDetails.connectionState} <> 'connected'`,
        inArray(campaignEnrollments.status, [...LIVE_ENROLLMENT_STATUSES]),
        // Only invitations that went out (or may have) can be accepted.
        sql`(${linkedinEnrollmentDetails.connectionState} = 'request_sent' or exists (select 1 from sends s where s.enrollment_id = ${campaignEnrollments.id} and s.step_number = 1 and s.status in ('sending', 'unknown', 'sent')))`,
      ),
    );
}

async function upsertConnection(tx: Tx, organizationId: string, accountId: string, member: string, extra: { name?: string | null; profileUrl?: string | null; chatId?: string | null; connected?: Date }) {
  await tx
    .insert(linkedinConnections)
    .values({
      organizationId,
      linkedinAccountId: accountId,
      providerId: member,
      name: extra.name ?? null,
      profileUrl: extra.profileUrl ?? null,
      chatId: extra.chatId ?? null,
      connectedAt: extra.connected ?? null,
    })
    .onConflictDoUpdate({
      target: [linkedinConnections.providerId, linkedinConnections.linkedinAccountId],
      set: {
        name: sql`coalesce(${linkedinConnections.name}, excluded.name)`,
        profileUrl: sql`coalesce(${linkedinConnections.profileUrl}, excluded.profile_url)`,
        chatId: sql`coalesce(${linkedinConnections.chatId}, excluded.chat_id)`,
        connectedAt: sql`coalesce(${linkedinConnections.connectedAt}, excluded.connected_at)`,
      },
    });
}

/** The LinkedIn inbound store. `inbox` files each reply and message. */
export function createDrizzleLinkedInInboundStore(inbox: InboxFiling): LinkedInInboundStore {
  return {
    async begin({ organizationId, key, eventType, accountRef, payload, now }) {
      const [row] = await db
        .insert(inboundEvents)
        .values({
          organizationId,
          provider: "unipile",
          providerEventKey: key,
          eventType,
          accountRef,
          payload,
          status: "processing",
          attempts: 1,
          nextAttemptAt: now,
          leaseUntil: new Date(now.getTime() + LEASE_SECONDS * 1000),
        })
        .onConflictDoNothing()
        .returning({ id: inboundEvents.id, organizationId: inboundEvents.organizationId, payload: inboundEvents.payload, attempts: inboundEvents.attempts });
      return row ? toLedger(row) : null;
    },

    async finish(id, status, note, now) {
      await db
        .update(inboundEvents)
        .set({ status, processedAt: now, leaseUntil: null, log: note ? logLine("info", note, now) : inboundEvents.log })
        .where(eq(inboundEvents.id, id));
    },

    async fail(id, error, now, retryAt) {
      await db
        .update(inboundEvents)
        .set({ status: "failed", leaseUntil: null, nextAttemptAt: retryAt ?? now, log: logLine("error", error, now) })
        .where(eq(inboundEvents.id, id));
    },

    async claimReplayable(now, limit, leaseSeconds, organizationId) {
      const nowIso = now.toISOString();
      const rows = await db.execute(sql`
        update inbound_events ev
           set status = 'processing', attempts = ev.attempts + 1, lease_until = ${new Date(now.getTime() + leaseSeconds * 1000).toISOString()}::timestamptz
         where ev.id in (
           select id from inbound_events
            where provider = 'unipile' and attempts < ${MAX_EVENT_ATTEMPTS}
              ${organizationId ? sql`and organization_id = ${organizationId}` : sql``}
              and ((status = 'failed' and next_attempt_at <= ${nowIso}::timestamptz)
                or (status = 'processing' and lease_until < ${nowIso}::timestamptz))
            order by created_at asc
            limit ${limit}
            for update skip locked
         )
        returning ev.id, ev.organization_id as "organizationId", ev.payload, ev.attempts
      `);
      return (rows as unknown as Array<{ id: string; organizationId: string | null; payload: unknown; attempts: number }>).map(toLedger);
    },

    async apply(organizationId, event, now) {
      const outcome = await db.transaction(async (tx): Promise<{ done: { result: InboundResult; note: string | null } } | { reply: ReplyContext }> => {
        const [account] = await tx.select().from(linkedinAccounts).where(and(eq(linkedinAccounts.organizationId, organizationId), eq(linkedinAccounts.providerAccountId, event.account)));
        // The lookup is scoped to the organization the secret belongs to, so another tenant's account never resolves.
        if (!account) return { done: { result: "skipped" as const, note: "Unknown account for this organization." } };

        if (event.type === "connection_accepted") {
          await upsertConnection(tx, organizationId, account.id, event.member, { name: event.name, profileUrl: event.profileUrl, connected: now });
          const waiting = await waitingForAcceptance(tx, organizationId, account.id, event.member);
          let applied = 0;
          for (const e of waiting) if (await applyAcceptance(tx, e.id, e.steps[1]?.waitDays ?? null, now)) applied += 1;
          return { done: { result: "done" as const, note: applied === 0 ? "No lead was waiting for this acceptance." : `Accepted: ${applied} lead(s).` } };
        }

        if (!event.counterparty) return { done: { result: "skipped" as const, note: "Could not tell who the other person is." } };
        await upsertConnection(tx, organizationId, account.id, event.counterparty, { chatId: event.chat });

        if (event.fromAccountOwner) {
          // A note-carrying invitation opens a chat with only our note once accepted. Anything else we wrote is an echo.
          const waiting = await waitingForAcceptance(tx, organizationId, account.id, event.counterparty);
          let applied = 0;
          for (const e of waiting) if (await applyAcceptance(tx, e.id, e.steps[1]?.waitDays ?? null, now)) applied += 1;
          return { done: { result: applied > 0 ? ("done" as const) : ("skipped" as const), note: applied > 0 ? "Echo treated as acceptance." : "Echo of our own message." } };
        }

        // The reply ends the person's outreach in the transaction that stores the message (stopPersonOutreachOnReplyTx).
        // Finished enrollments keep their status; only pending and active ones stop.
        const ofMember = tx.select({ id: linkedinEnrollmentDetails.enrollmentId }).from(linkedinEnrollmentDetails).where(eq(linkedinEnrollmentDetails.providerId, event.counterparty));

        // The lead this chat is about, whatever state their enrollment ended in.
        const [lead] = await tx
          .select({ personId: campaignEnrollments.personId })
          .from(campaignEnrollments)
          .where(and(eq(campaignEnrollments.organizationId, organizationId), eq(campaignEnrollments.linkedinAccountId, account.id), inArray(campaignEnrollments.id, ofMember)))
          .orderBy(asc(campaignEnrollments.createdAt))
          .limit(1);
        const [connection] = await tx
          .select({ name: linkedinConnections.name, profileUrl: linkedinConnections.profileUrl, chatId: linkedinConnections.chatId })
          .from(linkedinConnections)
          .where(and(eq(linkedinConnections.linkedinAccountId, account.id), eq(linkedinConnections.providerId, event.counterparty)));
        // A lead in a personal campaign makes the whole thread private, whichever enrollment is the oldest. Before the lead's profile
        // resolved, their enrollment has no member id, and it can sit on another account of the organization, so the match also
        // goes through the person: the stored member id or the public profile slug.
        const profileUrl = event.counterpartyProfileUrl ?? connection?.profileUrl ?? null;
        const slug = profileUrl ? linkedinSlug(profileUrl) : null;
        const [personal] = await tx
          .select({ campaignId: campaigns.id, personId: campaignEnrollments.personId })
          .from(campaignEnrollments)
          .innerJoin(campaigns, and(eq(campaigns.id, campaignEnrollments.campaignId), eq(campaigns.organizationId, campaignEnrollments.organizationId)))
          .innerJoin(people, and(eq(people.id, campaignEnrollments.personId), eq(people.organizationId, campaignEnrollments.organizationId)))
          .where(
            and(
              eq(campaignEnrollments.organizationId, organizationId),
              eq(campaigns.type, "personal"),
              or(
                inArray(campaignEnrollments.id, ofMember),
                sql`${people.raw}->>'linkedin_member_id' = ${event.counterparty}`,
                slug ? eq(people.linkedinSlug, slug) : undefined,
              ),
            ),
          )
          .orderBy(asc(campaignEnrollments.createdAt))
          .limit(1);
        return {
          reply: {
            accountId: account.id,
            accountName: account.name ?? account.username,
            personId: lead?.personId ?? personal?.personId ?? null,
            knownName: connection?.name ?? null,
            knownProfileUrl: connection?.profileUrl ?? null,
            knownChatId: connection?.chatId ?? null,
            privateCampaignId: personal?.campaignId ?? null,
          },
        };
      });
      if ("done" in outcome) return outcome.done;

      // After the sequence stopped: a replayed event repeats both steps, and both are idempotent.
      return storeReply(inbox, organizationId, event as ReplyEvent, outcome.reply, now);
    },
  };
}

type ReplyEvent = Extract<LinkedInInboundEvent, { type: "message_received" }>;

interface ReplyContext {
  accountId: string;
  accountName: string | null;
  personId: string | null;
  knownName: string | null;
  knownProfileUrl: string | null;
  knownChatId: string | null;
  privateCampaignId: string | null;
}

/** Files the message in the master inbox. Matched replies go under their lead, other real messages under a new inbound person. */
async function storeReply(inbox: InboxFiling, organizationId: string, event: ReplyEvent, ctx: ReplyContext, now: Date): Promise<{ result: InboundResult; note: string | null }> {
  const member = event.counterparty as string;
  const profileUrl = event.counterpartyProfileUrl ?? ctx.knownProfileUrl;
  const sentAt = event.sentAt ? new Date(event.sentAt) : null;
  const stored = await inbox.linkedin({
    organizationId,
    accountRef: ctx.accountId,
    accountName: ctx.accountName,
    providerThreadId: event.chat ?? ctx.knownChatId ?? `member:${member}`,
    providerMessageId: event.messageId as string,
    counterparty: { providerId: member, name: event.counterpartyName ?? ctx.knownName, profileUrl, slug: profileUrl ? linkedinSlug(profileUrl) : null },
    personId: ctx.personId,
    privateCampaignId: ctx.privateCampaignId,
    bodyText: event.text,
    receivedAt: sentAt && !Number.isNaN(sentAt.getTime()) ? sentAt : now,
  });
  const filedNote =
    ctx.privateCampaignId && stored.status !== "quarantined"
      ? "Kept private (personal campaign)."
      : stored.status === "quarantined" ? "Held for review at /inbox/unmatched (sender has no profile identity)." : stored.status === "created" ? "Stored in the inbox." : "Already in the inbox.";
  const stopped = stored.status === "created" ? (stored.outreachStopped ?? 0) : 0;
  return stopped > 0
    ? { result: "done", note: `Reply stopped ${stopped} sequence(s). ${filedNote}` }
    : { result: "done", note: `Message from someone in no sequence. ${filedNote}` };
}
