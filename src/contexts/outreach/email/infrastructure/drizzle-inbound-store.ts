import { and, asc, count, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import { campaignEnrollments, inboundEvents, mailboxes, people, sends } from "@/platform/db/schema";
import type { FollowUpStop, InboundStore, InboxFiling, MessageFailureState, SyncMailbox } from "../../application/inbound-ports";
import type { InboundEmail } from "../../application/ports";
import { isVerifiedBounce } from "../domain/bounce";
import { createSuppressionStore } from "../../infrastructure/suppression-store";
import { LIVE_ENROLLMENT_STATUSES } from "../../domain/enrollment-status";

type Tx = DbTx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Message-IDs show up with and without angle brackets depending on the header and the adapter. */
function rfcIdVariants(email: InboundEmail): string[] {
  const out = new Set<string>();
  for (const raw of [email.inReplyTo, ...email.references]) {
    const bare = raw?.trim().replace(/^<|>$/g, "");
    if (!bare) continue;
    out.add(bare);
    out.add(`<${bare}>`);
  }
  return [...out];
}

/** Finds the enrollment this message answers: our send id, then Message-ID headers, then the thread. */
async function matchEnrollment(tx: Tx, mailbox: SyncMailbox, email: InboundEmail): Promise<string | null> {
  const inOrg = and(eq(sends.organizationId, mailbox.organizationId), eq(sends.channel, "email"));
  const pick = async (where: ReturnType<typeof and>) => {
    const [row] = await tx.select({ enrollmentId: sends.enrollmentId }).from(sends).where(and(inOrg, where)).orderBy(asc(sends.createdAt)).limit(1);
    return row?.enrollmentId ?? null;
  };

  if (email.sendId && UUID.test(email.sendId)) {
    const found = await pick(eq(sends.id, email.sendId));
    if (found) return found;
  }
  const ids = rfcIdVariants(email);
  if (ids.length > 0) {
    const found = await pick(or(inArray(sends.rfcMessageId, ids), inArray(sends.providerMessageId, ids)));
    if (found) return found;
  }
  if (email.threadId) return pick(and(eq(sends.threadId, email.threadId), eq(sends.mailboxId, mailbox.id)));
  return null;
}

/** How far back a send still counts as "we mailed this address" when a bounce arrives. */
const BOUNCE_HORIZON_MS = 90 * 24 * 3600 * 1000;

/**
 * Facts a bounce needs before it may suppress anyone: did this mailbox mail the failed recipient recently,
 * and does the message point at that very send (our send id, or a Message-ID header of ours).
 */
async function bounceEvidence(mailbox: SyncMailbox, email: InboundEmail, failedRecipient: string, now: Date) {
  const sentToRecipient = and(
    eq(sends.organizationId, mailbox.organizationId),
    eq(sends.mailboxId, mailbox.id),
    eq(sends.channel, "email"),
    inArray(sends.status, ["sending", "sent", "unknown"]),
    gte(sends.claimedAt, new Date(now.getTime() - BOUNCE_HORIZON_MS)),
    sql`lower(${people.email}) = ${failedRecipient}`,
  );
  const find = async (extra?: ReturnType<typeof and>) => {
    const [row] = await db
      .select({ id: sends.id })
      .from(sends)
      .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
      .innerJoin(people, eq(people.id, campaignEnrollments.personId))
      .where(extra ? and(sentToRecipient, extra) : sentToRecipient)
      .limit(1);
    return row !== undefined;
  };
  const weSentToRecipient = await find();
  if (!weSentToRecipient) return { weSentToRecipient, tiedToOurSend: false };
  const ties = [];
  if (email.sendId && UUID.test(email.sendId)) ties.push(eq(sends.id, email.sendId));
  const ids = rfcIdVariants(email);
  if (ids.length > 0) ties.push(inArray(sends.rfcMessageId, ids), inArray(sends.providerMessageId, ids));
  return { weSentToRecipient, tiedToOurSend: ties.length > 0 && (await find(or(...ties))) };
}

/** Files a received message in the master inbox. Idempotent, so a replayed batch stores nothing twice. */
function storeInInbox(inbox: InboxFiling, mailbox: SyncMailbox, email: InboundEmail, autoReply: boolean, possibleBounce = false) {
  return inbox.email({
    organizationId: mailbox.organizationId,
    accountRef: mailbox.emailAddress,
    providerThreadId: email.threadId ?? email.providerMessageId,
    providerMessageId: email.providerMessageId,
    rfcMessageId: email.rfcMessageId,
    inReplyTo: email.inReplyTo,
    from: email.from,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    bodyText: email.bodyText,
    receivedAt: email.receivedAt,
    autoReply,
    ...(possibleBounce ? { possibleBounce } : {}),
  });
}

const eventKey = (mailbox: SyncMailbox, providerMessageId: string) => `inbound:${mailbox.emailAddress}:${providerMessageId}`;

/** The email inbound store. `inbox` files each message that is not a verified bounce or our own. */
export function createDrizzleInboundStore(inbox: InboxFiling, followUps: FollowUpStop): InboundStore {
  const suppression = createSuppressionStore(followUps);
  return {
    async listDueMailboxIds(dueBefore) {
      const rows = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(eq(mailboxes.status, "connected"), or(isNull(mailboxes.lastSyncedAt), lte(mailboxes.lastSyncedAt, dueBefore))))
        .orderBy(sql`${mailboxes.lastSyncedAt} asc nulls first`);
      return rows.map((r) => r.id);
    },

    async getMailbox(mailboxId) {
      const [row] = await db
        .select({ id: mailboxes.id, organizationId: mailboxes.organizationId, emailAddress: mailboxes.emailAddress, cursor: mailboxes.gmailHistoryCursor, status: mailboxes.status })
        .from(mailboxes)
        .where(eq(mailboxes.id, mailboxId));
      if (!row || row.status !== "connected") return null;
      return { id: row.id, organizationId: row.organizationId, emailAddress: row.emailAddress, cursor: row.cursor };
    },

    async applyInbound(mailbox, email, classification, now) {
      switch (classification.kind) {
        case "hard_bounce": {
          // The From name and the body text are attacker controlled. Suppress only a verified bounce.
          const evidence = await bounceEvidence(mailbox, email, classification.failedRecipient, now);
          const verified = isVerifiedBounce({ from: email.from.email, mailboxAddress: mailbox.emailAddress, failedRecipient: classification.failedRecipient, authenticationResults: email.headers["authentication-results"], ...evidence });
          if (!verified) {
            // Additive flag: a bounce for an address we mailed stays visible to a human, but suppresses nothing.
            await storeInInbox(inbox, mailbox, email, true, evidence.weSentToRecipient);
            return "unverified_bounce";
          }
          // One transaction inside: suppression row (conflict ignored) and the bounced enrollments.
          await suppression.suppressEmail({
            organizationId: mailbox.organizationId,
            email: classification.failedRecipient,
            reason: "bounced",
            note: `Bounced from ${mailbox.emailAddress}`,
          });
          return "hard_bounce";
        }
        case "soft_bounce":
          return "soft_bounce";
        case "own_message":
          return "own_message";
        case "auto_reply":
          await storeInInbox(inbox, mailbox, email, true);
          return "auto_reply";
        case "message": {
          const matched = await db.transaction(async (tx) => {
            const enrollmentId = await matchEnrollment(tx, mailbox, email);
            if (!enrollmentId) return false;
            await tx
              .update(campaignEnrollments)
              .set({ status: "replied", nextSendAt: null, stopReason: "replied", updatedAt: now })
              .where(
                and(
                  eq(campaignEnrollments.id, enrollmentId),
                  eq(campaignEnrollments.organizationId, mailbox.organizationId),
                  inArray(campaignEnrollments.status, [...LIVE_ENROLLMENT_STATUSES]),
                ),
              );
            return true;
          });
          // After the sequence stopped: a replayed batch repeats both steps, and both are idempotent.
          const stored = await storeInInbox(inbox, mailbox, email, false);
          // Mail from a lead without thread headers has no matched send, but the sender-address stop still ended its enrollments.
          return matched || (stored.status === "created" && (stored.outreachStopped ?? 0) > 0) ? "reply" : "unmatched_message";
        }
      }
    },

    async completeSync(mailboxId, previous, cursor, now, note) {
      await db
        .update(mailboxes)
        .set({ gmailHistoryCursor: cursor, lastSyncedAt: now, lastError: note })
        .where(
          and(
            eq(mailboxes.id, mailboxId),
            previous === null ? isNull(mailboxes.gmailHistoryCursor) : eq(mailboxes.gmailHistoryCursor, previous),
          ),
        );
    },

    async recordFailure(mailboxId, error) {
      await db.update(mailboxes).set({ lastError: error }).where(eq(mailboxes.id, mailboxId));
    },

    async loadFailures(mailbox, providerMessageIds) {
      const out = new Map<string, MessageFailureState>();
      if (providerMessageIds.length === 0) return out;
      const keys = providerMessageIds.map((id) => eventKey(mailbox, id));
      const rows = await db
        .select({ key: inboundEvents.providerEventKey, attempts: inboundEvents.attempts, status: inboundEvents.status })
        .from(inboundEvents)
        .where(and(eq(inboundEvents.provider, "gmail"), inArray(inboundEvents.providerEventKey, keys), inArray(inboundEvents.status, ["pending", "failed", "skipped"])));
      const prefix = eventKey(mailbox, "");
      // A dismissed message (skipped) stays ignored if a replayed batch brings it back.
      for (const row of rows) out.set((row.key as string).slice(prefix.length), { attempts: row.attempts, deadLettered: row.status !== "pending" });
      return out;
    },

    async loadRetryIds(mailbox, limit) {
      const rows = await db
        .select({ key: inboundEvents.providerEventKey })
        .from(inboundEvents)
        .where(
          and(
            eq(inboundEvents.provider, "gmail"),
            eq(inboundEvents.organizationId, mailbox.organizationId),
            eq(inboundEvents.accountRef, mailbox.emailAddress),
            eq(inboundEvents.eventType, "inbound_email"),
            eq(inboundEvents.status, "pending"),
          ),
        )
        .orderBy(asc(inboundEvents.createdAt))
        .limit(limit);
      const prefix = eventKey(mailbox, "");
      return rows.map((r) => (r.key as string).slice(prefix.length));
    },

    async recordMessageGone(mailbox, providerMessageId, now) {
      const entry = JSON.stringify([{ ts: now.toISOString(), level: "error", message: "The message is no longer in the mailbox (deleted, or moved to sent or drafts)." }]);
      await db
        .update(inboundEvents)
        .set({ status: "failed", processedAt: now, log: sql`${inboundEvents.log} || ${entry}::jsonb` })
        .where(and(eq(inboundEvents.provider, "gmail"), eq(inboundEvents.providerEventKey, eventKey(mailbox, providerMessageId)), eq(inboundEvents.status, "pending")));
    },

    async recordMessageFailure(mailbox, email, error, maxAttempts, now) {
      const entry = JSON.stringify([{ ts: now.toISOString(), level: "error", message: error.slice(0, 500) }]);
      const [row] = await db
        .insert(inboundEvents)
        .values({
          organizationId: mailbox.organizationId,
          provider: "gmail",
          providerEventKey: eventKey(mailbox, email.providerMessageId),
          eventType: "inbound_email",
          accountRef: mailbox.emailAddress,
          payload: {
            providerMessageId: email.providerMessageId,
            threadId: email.threadId,
            from: email.from,
            subject: email.subject,
            receivedAt: email.receivedAt.toISOString(),
            bodyText: email.bodyText.slice(0, 2000),
          },
          status: maxAttempts <= 1 ? "failed" : "pending",
          attempts: 1,
          log: JSON.parse(entry),
        })
        .onConflictDoUpdate({
          target: [inboundEvents.provider, inboundEvents.providerEventKey],
          targetWhere: sql`${inboundEvents.providerEventKey} is not null`,
          set: {
            attempts: sql`case when ${inboundEvents.status} = 'done' then 1 else ${inboundEvents.attempts} + 1 end`,
            status: sql`case when ${inboundEvents.status} = 'failed' or (case when ${inboundEvents.status} = 'done' then 1 else ${inboundEvents.attempts} + 1 end) >= ${maxAttempts} then 'failed' else 'pending' end`,
            processedAt: null,
            log: sql`${inboundEvents.log} || ${entry}::jsonb`,
          },
        })
        .returning({ attempts: inboundEvents.attempts, status: inboundEvents.status });
      return { attempts: row.attempts, deadLettered: row.status === "failed" };
    },

    async clearMessageFailure(mailbox, providerMessageId, now) {
      await db
        .update(inboundEvents)
        .set({ status: "done", processedAt: now })
        .where(and(eq(inboundEvents.provider, "gmail"), eq(inboundEvents.providerEventKey, eventKey(mailbox, providerMessageId)), eq(inboundEvents.status, "pending")));
    },

    async countDeadLetters(mailbox, since) {
      const [row] = await db
        .select({ n: count() })
        .from(inboundEvents)
        .where(
          and(
            eq(inboundEvents.provider, "gmail"),
            eq(inboundEvents.organizationId, mailbox.organizationId),
            eq(inboundEvents.accountRef, mailbox.emailAddress),
            eq(inboundEvents.eventType, "inbound_email"),
            eq(inboundEvents.status, "failed"),
            gte(inboundEvents.createdAt, since),
          ),
        );
      return row.n;
    },
  };
}
