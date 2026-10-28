import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, type DbHandle } from "@/platform/db/client";
import { contactPolicies, mailboxes, people, sends } from "@/platform/db/schema";
import { mailboxPolicyViolation } from "../application/mailbox-management";
import { SEND_FROM, SEND_FROM_CALL, SEND_UNRESOLVED, type SendStatus } from "../../domain/send-status";
import type { TestSendStore, UncertainTestSend } from "../application/send-test-email";
import { isSuppressed } from "@/contexts/people/infrastructure/reachability";
import { recordAudit } from "@/contexts/tenancy/infrastructure/audit";

const UNRESOLVED = [...SEND_UNRESOLVED];
const canSend = (to: SendStatus) => inArray(sends.status, [...SEND_FROM[to]]);
/** The claiming worker settling its own row. */
const fromCall = inArray(sends.status, [...SEND_FROM_CALL]);
const TEST = eq(sends.kind, "test");

export const drizzleTestSendStore: TestSendStore = {
  async claim(input) {
    return db.transaction(async (tx) => {
      // Same row lock as a campaign claim (without skipLocked: a test send waits for a send in progress instead of skipping it).
      const [mailbox] = await tx
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.organizationId, input.organizationId)))
        .for("update");
      if (!mailbox) return { kind: "not_found" as const };
      if (mailbox.status !== "connected") return { kind: "blocked" as const, reason: "mailbox_not_connected" as const };
      const violation = mailboxPolicyViolation(input.domainPolicy, mailbox.emailAddress);
      if (violation) return { kind: "blocked" as const, reason: "domain_policy" as const, detail: violation };

      const since = new Date(input.now.getTime() - input.windowMinutes * 60_000);
      const recent = await tx
        .select({ claimedAt: sends.claimedAt, status: sends.status })
        .from(sends)
        .where(and(eq(sends.mailboxId, mailbox.id), TEST, gte(sends.claimedAt, since)))
        .orderBy(asc(sends.claimedAt));
      const flightSince = input.now.getTime() - input.inFlightMinutes * 60_000;
      if (recent.some((r) => r.status === "sending" && r.claimedAt.getTime() >= flightSince)) return { kind: "blocked" as const, reason: "in_flight" as const };
      if (recent.length >= input.limit) return { kind: "rate_limited" as const, oldestClaimedAt: recent[recent.length - input.limit].claimedAt };

      const block = await recipientBlockTx(tx, input.organizationId, input.to);
      if (block) return { kind: "blocked" as const, reason: block };

      const [row] = await tx
        .insert(sends)
        .values({
          organizationId: input.organizationId,
          kind: "test",
          channel: "email",
          status: "sending",
          mailboxId: mailbox.id,
          toAddress: input.to,
          requestedBy: input.requestedBy,
          claimedAt: input.now,
        })
        .returning({ id: sends.id });
      return {
        kind: "claimed" as const,
        sendId: row.id,
        organizationId: input.organizationId,
        to: input.to,
        mailbox: { id: mailbox.id, emailAddress: mailbox.emailAddress, displayName: mailbox.displayName, signatureHtml: mailbox.signatureHtml },
      };
    });
  },

  async recordRendered(sendId, rendered) {
    await db.update(sends).set({ subject: rendered.subject, body: rendered.body, rfcMessageId: rendered.rfcMessageId }).where(and(eq(sends.id, sendId), TEST));
  },

  recipientBlock: (organizationId, to) => recipientBlockTx(db, organizationId, to),

  async abandon(sendId, reason) {
    await db.update(sends).set({ status: "failed", error: reason }).where(and(eq(sends.id, sendId), TEST, fromCall));
  },

  async markSent(sendId, sent, now) {
    await db
      .update(sends)
      .set({ status: "sent", providerMessageId: sent.providerMessageId, threadId: sent.threadId, sentAt: now, error: null })
      .where(and(eq(sends.id, sendId), TEST, fromCall));
  },

  async markFailed(sendId, error) {
    await db.update(sends).set({ status: "failed", error }).where(and(eq(sends.id, sendId), TEST, fromCall));
  },

  async markUnknown(sendId, error) {
    await db.update(sends).set({ status: "unknown", error }).where(and(eq(sends.id, sendId), TEST, fromCall));
  },

  async audit(entry) {
    await recordAudit(db, {
      organizationId: entry.organizationId,
      actorUserId: entry.actorUserId,
      action: "mailbox.test_sent",
      entityType: "mailbox",
      entityId: entry.mailboxId,
      meta: { sendId: entry.sendId, to: entry.to, status: entry.status },
    });
  },

  async listUncertain(olderThan, limit): Promise<UncertainTestSend[]> {
    const rows = await db
      .select({
        sendId: sends.id,
        organizationId: sends.organizationId,
        mailboxEmail: mailboxes.emailAddress,
        to: sends.toAddress,
        claimedAt: sends.claimedAt,
        rfcMessageId: sends.rfcMessageId,
      })
      .from(sends)
      .innerJoin(mailboxes, eq(mailboxes.id, sends.mailboxId))
      .where(and(TEST, inArray(sends.status, UNRESOLVED), lte(sends.claimedAt, olderThan)))
      .orderBy(asc(sends.claimedAt))
      .limit(limit);
    return rows.map((r) => ({ ...r, to: r.to ?? "" }));
  },

  async settle(sendId, outcome) {
    if (outcome.status === "sent") {
      const where = and(eq(sends.id, sendId), TEST, canSend("sent"));
      await db.update(sends).set({ status: "sent", providerMessageId: outcome.sent.providerMessageId, threadId: outcome.sent.threadId, sentAt: outcome.now, error: null }).where(where);
    } else {
      await db.update(sends).set({ status: "failed", error: outcome.error }).where(and(eq(sends.id, sendId), TEST, canSend("failed")));
    }
  },
};

type Reader = DbHandle;

/** The suppression list, then any lead with this address that is marked do not contact. */
async function recipientBlockTx(tx: Reader, organizationId: string, to: string): Promise<"suppressed" | "do_not_contact" | null> {
  if (await isSuppressed(tx, organizationId, to)) return "suppressed";
  const [dnc] = await tx
    .select({ id: contactPolicies.personId })
    .from(contactPolicies)
    .innerJoin(people, and(eq(people.id, contactPolicies.personId), eq(people.organizationId, contactPolicies.organizationId)))
    .where(and(eq(contactPolicies.organizationId, organizationId), eq(contactPolicies.doNotContact, true), sql`lower(${people.email}) = ${to.toLowerCase()}`))
    .limit(1);
  return dnc ? "do_not_contact" : null;
}
