import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DbTx } from "@/platform/db/client";
import { lockPersonOutreachTx } from "@/platform/db/person-locks";
import { conversations, drafts, events, messages, people } from "@/platform/db/schema";
import type { ContactStop, OutreachStopTarget, OutreachStopTrigger } from "@/contexts/outreach/application/inbound-ports";
import { haltEnrollmentsTx, type EndedEnrollment } from "@/contexts/outreach/infrastructure/enrollment-end";
import { suppressionKey } from "@/contexts/people/domain/reachability";
import { suppressAddressTx, writeDoNotContactTx } from "@/contexts/people/infrastructure/reachability";
import { interruptPersonRunsTx } from "../../after-reply/infrastructure/follow-up-stop";
import { afterPersonDecision } from "../../domain/workflow-state";
import { advanceConversationContextTx } from "../../infrastructure/conversation-context";
import { STOP_TABLE, type StopRow } from "../domain/stop-table";
import { personReviewedStopsTx } from "./stop-review";

export type StopTarget = OutreachStopTarget;

/** What ended, and what people's writer recorded. A count stays 0 when the trigger has nothing to end. */
export interface StopResult {
  enrollments: number;
  runs: number;
  drafts: number;
  conversations: number;
  /** The suppression list gained the address. */
  added: boolean;
  /** False for do not contact on a person already marked. Nothing else ran. */
  changed: boolean;
  /** The policy before a do not contact trigger, or null when the person had no row. */
  previousPolicy: { doNotContact: boolean; reason: string | null } | null;
}

/** Outreach raises its triggers through its `ContactStop` port; conversations and the conversion raise the rest. */
export type StopTrigger =
  | OutreachStopTrigger
  | { kind: "reply"; channel: "email" | "linkedin"; now: Date }
  | { kind: "sender_suppressed"; conversationId: string; personId: string; threadId: string; actorUserId: string; note: string; now: Date }
  | { kind: "do_not_contact"; reason: string; actorUserId: string; now: Date }
  | { kind: "conversion"; now: Date };

const nothing = (): StopResult => ({ enrollments: 0, runs: 0, drafts: 0, conversations: 0, added: false, changed: true, previousPolicy: null });

/**
 * Stops contact for one trigger, in the caller's transaction. It finds the people the trigger reaches, takes their locks in
 * the documented order (`lockReachedPeopleTx`), records the mark through people's writers, ends what the trigger's row in
 * `STOP_TABLE` lists and writes the row's events. The conversion writes its own `lifecycle.converted` event.
 */
export async function stopContactTx(tx: DbTx, target: StopTarget, trigger: StopTrigger): Promise<StopResult> {
  const row = STOP_TABLE[trigger.kind];
  const { organizationId } = target;
  const { now } = trigger;
  if ((row.people === "address_owners") !== "email" in target) throw new Error(`The ${trigger.kind} stop takes ${row.people === "address_owners" ? "an address" : "a person"}.`);
  const result = nothing();
  // A batch that replays reaches the early stop again for a message it did file, and a person may have enrolled that lead again since.
  if (trigger.kind === "reply" && "unlessFiled" in trigger && (await messageFiled(tx, organizationId, trigger))) return result;

  const personIds = "email" in target ? await addressOwners(tx, organizationId, suppressionKey(target.email)) : row.people === "person_and_sender" ? await personAndSender(tx, target) : [target.personId];
  await lockReachedPeopleTx(tx, organizationId, personIds);

  if ("email" in target) {
    const fromList = trigger.kind === "bounce" || trigger.kind === "unsubscribe" || trigger.kind === "suppression" ? trigger : null;
    const note = trigger.kind === "sender_suppressed" ? trigger.note : fromList?.note;
    const listed = await suppressAddressTx(tx, { organizationId, email: target.email, reason: row.suppressionReason!, note, addedInSettings: fromList?.addedInSettings });
    result.added = listed.added;
  } else if (row.marksDoNotContact && trigger.kind === "do_not_contact") {
    const written = await writeDoNotContactTx(tx, { organizationId, personId: target.personId, enabled: true, reason: trigger.reason, now });
    result.previousPolicy = written.previous;
    if (!written.changed) return { ...result, changed: false };
  }
  if (personIds.length === 0) return result;
  if (row.settlesConversations && trigger.kind === "do_not_contact" && "personId" in target) {
    const settled = await settleConversationsTx(tx, organizationId, target.personId, trigger, row);
    result.conversations = settled.conversations;
    result.drafts += settled.drafts;
  }

  const ended = await haltEnrollmentsTx(tx, { organizationId, personIds, channels: row.enrollments, halt: row.halt, now });
  result.enrollments = ended.length;
  const stopped = await interruptPersonRunsTx(tx, organizationId, personIds, row.runReason, now, row.runs);
  result.runs = stopped.runs;
  result.drafts += stopped.drafts;
  await writeStopEventsTx(tx, target, trigger, row, ended, result);
  return result;
}

/**
 * The lock order of `docs/decisions.md` ("Conversion and lock order") up to the enrollments: the conversations of everyone
 * reached in id order, then their outreach locks in id order. Marks come after it, because a suppression row's unique key
 * and a `contact_policies` row are locks of their own, and holding one while waiting on a conversation can close a cycle.
 * Every trigger takes the outreach lock: a restore of a removed lead and a person delete read a person's marks under it and
 * then write, so a stop that skipped it could commit between that read and that write.
 */
async function lockReachedPeopleTx(tx: DbTx, organizationId: string, personIds: string[]): Promise<void> {
  if (personIds.length === 0) return;
  await tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.organizationId, organizationId), inArray(conversations.personId, personIds))).orderBy(conversations.id).for("no key update");
  await lockPersonOutreachTx(tx, organizationId, personIds);
}

/** The conversation's waiting review draft retires and the row's event goes in, for the triggers that write them here. */
async function writeStopEventsTx(tx: DbTx, target: StopTarget, trigger: StopTrigger, row: StopRow, ended: EndedEnrollment[], result: StopResult): Promise<void> {
  const { organizationId } = target;
  if (trigger.kind === "sender_suppressed") {
    // A draft waiting for review would be refused at send time anyway.
    const retired = await tx
      .update(drafts)
      .set({ status: "stale", error: row.draftError })
      .where(and(eq(drafts.conversationId, trigger.conversationId), eq(drafts.status, "awaiting_review")))
      .returning({ id: drafts.id });
    result.drafts += retired.length;
    await tx.insert(events).values({
      organizationId,
      personId: trigger.personId,
      conversationId: trigger.conversationId,
      eventType: row.eventType!,
      actorType: "human",
      actorUserId: trigger.actorUserId,
      meta: { threadId: trigger.threadId },
    });
  }
  if (trigger.kind === "reply") {
    for (const personId of new Set(ended.map((e) => e.personId))) {
      const own = ended.filter((e) => e.personId === personId);
      await tx.insert(events).values({
        organizationId,
        personId,
        eventType: row.eventType!,
        actorType: "system",
        toData: { status: "replied" },
        meta: { replyChannel: trigger.channel, enrollmentIds: own.map((e) => e.id), channels: [...new Set(own.map((e) => e.channel))] },
      });
    }
  }
  if (trigger.kind === "do_not_contact" && "personId" in target) {
    const previous = result.previousPolicy;
    await tx.insert(events).values({
      organizationId,
      personId: target.personId,
      eventType: row.eventType!,
      actorType: "human",
      actorUserId: trigger.actorUserId,
      fromData: previous ? { doNotContact: previous.doNotContact, reason: previous.reason } : null,
      toData: { doNotContact: true, reason: trigger.reason },
      meta: { enrollmentsStopped: result.enrollments, draftsRetired: result.drafts, conversations: result.conversations },
    });
  }
}

/** Whether the message already sits in the Inbox. Filing stops outreach in its own transaction, so an early stop for it has nothing left to do. */
async function messageFiled(tx: DbTx, organizationId: string, trigger: Extract<OutreachStopTrigger, { unlessFiled: unknown }>): Promise<boolean> {
  const { accountRef, providerMessageId } = trigger.unlessFiled;
  const [filed] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.organizationId, organizationId), eq(messages.channel, trigger.channel), eq(messages.accountRef, accountRef), eq(messages.providerMessageId, providerMessageId)))
    .limit(1);
  return filed !== undefined;
}

/** The person the message was filed under, plus anyone in the organization with the sender's address (mail without thread headers, or a new thread). */
async function personAndSender(tx: DbTx, target: Extract<StopTarget, { personId: string }>): Promise<string[]> {
  const sender = target.senderEmail?.trim().toLowerCase() || null;
  const found = await tx
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.organizationId, target.organizationId), or(eq(people.id, target.personId), sender ? sql`lower(${people.email}) = ${sender}` : undefined)))
    .orderBy(people.id);
  return found.map((p) => p.id);
}

/** Every person in the organization with this address. `key` is the form `suppressionKey` stores. */
async function addressOwners(tx: DbTx, organizationId: string, key: string): Promise<string[]> {
  const found = await tx.select({ id: people.id }).from(people).where(and(eq(people.organizationId, organizationId), sql`lower(${people.email}) = ${key}`)).orderBy(people.id);
  return found.map((p) => p.id);
}

/** Every conversation of the person returns to a person, retires its open drafts and counts as reviewed. */
async function settleConversationsTx(tx: DbTx, organizationId: string, personId: string, trigger: Extract<StopTrigger, { kind: "do_not_contact" }>, row: StopRow): Promise<{ conversations: number; drafts: number }> {
  const owned = await tx.select().from(conversations).where(and(eq(conversations.personId, personId), eq(conversations.organizationId, organizationId))).orderBy(conversations.id).for("no key update");
  let retired = 0;
  for (const conversation of owned) {
    const advanced = await advanceConversationContextTx(tx, {
      organizationId,
      conversationId: conversation.id,
      now: trigger.now,
      set: { workflowState: afterPersonDecision(conversation.workflowState), nextActionAt: null },
      drafts: { reason: row.draftError! },
    });
    await personReviewedStopsTx(tx, { organizationId, conversationId: conversation.id, actorUserId: trigger.actorUserId, now: trigger.now });
    retired += advanced.draftsRetired;
    await tx.insert(events).values({
      organizationId,
      personId,
      conversationId: conversation.id,
      eventType: row.conversationEventType!,
      actorType: "human",
      actorUserId: trigger.actorUserId,
      fromData: { workflowState: conversation.workflowState },
      meta: { policy: "do_not_contact", reason: trigger.reason },
      contextVersion: advanced.contextVersion,
    });
  }
  return { conversations: owned.length, drafts: retired };
}

/** What src/composition hands outreach, so outreach raises its triggers without importing conversations. */
export const contactStop: ContactStop = { stopContactTx };
