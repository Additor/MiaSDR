import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import {
  campaignEnrollments,
  campaigns,
  channelSettings,
  companies,
  contactPolicies,
  entityColumns,
  mailboxes,
  people,
  sends,
  suppressionList,
} from "@/platform/db/schema";
import type { BlockReason, ClaimOptions, OutreachStore, SendClaim, UncertainSend } from "../application/ports";
import { mailboxPolicyViolation } from "../application/mailbox-management";
import { readSendPause } from "../../domain/send-pause";
import { mailboxBlock } from "../../domain/send-policy";
import { SEND_COUNTED, SEND_FROM, SEND_FROM_CALL, SEND_UNRESOLVED, type SendStatus } from "../../domain/send-status";
import { takeoverCutoff } from "../domain/takeover";
import { buildVariables } from "../../domain/variables";
import { startOfLocalDay, type WorkingHours } from "../../domain/working-hours";
import { LIVE_ENROLLMENT_STATUSES } from "../../domain/enrollment-status";

type Tx = DbTx;

/** Enrollment statuses a send may still change. Every later status was set on purpose and must survive a late send result. */
const LIVE_STATUSES = [...LIVE_ENROLLMENT_STATUSES];


/** Rows that still hold a provider-side question. */
const UNRESOLVED = [...SEND_UNRESOLVED];
const canSend = (to: SendStatus) => inArray(sends.status, [...SEND_FROM[to]]);
/** The claiming worker settling its own row. */
const fromCall = inArray(sends.status, [...SEND_FROM_CALL]);
/** The claiming worker settling its own claim: a later attempt on the same row belongs to another worker. */
const ownClaim = (claim: { sendId: string; attempt: number }) => and(eq(sends.id, claim.sendId), fromCall, eq(sends.attempt, claim.attempt));

interface CandidateRow {
  id: string;
  organization_id: string;
  campaign_id: string;
  person_id: string;
  current_step: number;
  /** The mailbox this follow-up is pinned to (or last sent from) when it differs from the claiming mailbox, else null. */
  taken_over_from: string | null;
}

async function channelValues(tx: Tx, organizationId: string, channel: string): Promise<Record<string, unknown> | null> {
  const [row] = await tx
    .select({ values: channelSettings.values })
    .from(channelSettings)
    .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, channel)));
  return row?.values ?? null;
}

function zoneOf(general: Record<string, unknown> | null): string | null {
  const zone = general?.timeZone;
  return typeof zone === "string" ? zone : null;
}

export const drizzleOutreachStore: OutreachStore = {
  async listSendableMailboxIds(now, policy) {
    const rows = await db
      .select({ id: mailboxes.id, emailAddress: mailboxes.emailAddress, due: sql<boolean>`(${mailboxes.nextSendAt} is null or ${mailboxes.nextSendAt} <= ${now.toISOString()}::timestamptz)` })
      .from(mailboxes)
      .where(eq(mailboxes.status, "connected"))
      .orderBy(sql`${mailboxes.nextSendAt} asc nulls first`);
    const ids: string[] = [];
    let blockedByDomainPolicy = 0;
    for (const row of rows) {
      if (mailboxPolicyViolation(policy, row.emailAddress)) blockedByDomainPolicy += 1;
      else if (row.due) ids.push(row.id);
    }
    return { ids, blockedByDomainPolicy };
  },

  async claimNext(options: ClaimOptions): Promise<SendClaim | null> {
    return db.transaction(async (tx) => {
      const [mailbox] = await tx
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.id, options.mailboxId))
        .for("update", { skipLocked: true });
      if (!mailbox) return null;
      if (options.domainPolicy && mailboxPolicyViolation(options.domainPolicy, mailbox.emailAddress)) return null;

      const general = await channelValues(tx, mailbox.organizationId, "general");
      // An owner or admin paused outreach for this organization: claim nothing, like PAUSE_OUTBOUND for one organization.
      if (readSendPause(general)) return null;
      const zone = zoneOf(general);
      const workingHours: WorkingHours = (mailbox.workingHours as WorkingHours | null) ?? options.defaultWorkingHours(zone);

      const [{ sentToday }] = await tx
        .select({ sentToday: sql<number>`count(*)::int` })
        .from(sends)
        .where(
          and(
            eq(sends.mailboxId, mailbox.id),
            // Test sends (rate limited by their own partial index) do not use the campaign daily limit.
            eq(sends.kind, "campaign"),
            inArray(sends.status, SEND_COUNTED),
            sql`${sends.claimedAt} >= ${startOfLocalDay(options.now, workingHours.timeZone).toISOString()}::timestamptz`,
          ),
        );

      const block = mailboxBlock(options.now, {
        status: mailbox.status,
        nextSendAt: mailbox.nextSendAt,
        dailySendLimit: mailbox.dailySendLimit,
        sentToday,
        workingHours,
      });
      if (block) return null;

      const nowIso = options.now.toISOString();
      const emailValues = await channelValues(tx, mailbox.organizationId, "email");
      const takeoverCutoffIso = takeoverCutoff(options.now, options.takeoverAfterHours(emailValues)).toISOString();
      // A concurrent worker may win the same enrollment between our snapshot and our lock. The unique claim
      // rejects the loser safely, and the loser moves on to the next lead instead of idling.
      const lost: string[] = [];
      let candidate: CandidateRow | undefined;
      let claimRow: { id: string; attempt: number } | undefined;
      let stepNumber = 0;
      for (let tries = 0; tries < 5 && !claimRow; tries++) {
        const exclude = lost.length ? sql`and e.id not in (${sql.join(lost.map((id) => sql`${id}`), sql`, `)})` : sql``;
        const candidates = (await tx.execute(sql`
          select e.id, e.organization_id, e.campaign_id, e.person_id, e.current_step,
            case when e.status = 'active' and e.mailbox_id is distinct from ${mailbox.id}::uuid then coalesce(
              e.mailbox_id,
              (select s.mailbox_id from sends s where s.enrollment_id = e.id and s.status = 'sent' order by s.step_number desc limit 1)
            ) end as taken_over_from
          from campaign_enrollments e
          join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
          join people p on p.id = e.person_id and p.organization_id = e.organization_id
          left join mailboxes pm on pm.id = e.mailbox_id and pm.organization_id = e.organization_id
          where e.organization_id = ${mailbox.organizationId}
            and e.channel = 'email'
            and c.status = 'active'
            and p.email is not null
            and jsonb_array_length(c.steps) > e.current_step
            and (e.next_send_at is null or e.next_send_at <= ${nowIso}::timestamptz)
            and (
              (e.status = 'active' and e.mailbox_id = ${mailbox.id})
              or e.status = 'pending'
              -- Takeover: the pinned mailbox is not connected (or gone) and has been unable for longer than the delay.
              -- A connected mailbox that is only out of hours, throttled or at its limit never matches here.
              or (
                e.status = 'active' and e.current_step > 0 and e.mailbox_id is distinct from ${mailbox.id}::uuid
                and (
                  (pm.id is null and coalesce(e.next_send_at, e.updated_at) <= ${takeoverCutoffIso}::timestamptz)
                  or (pm.status <> 'connected' and coalesce(pm.unavailable_since, e.next_send_at, e.updated_at) <= ${takeoverCutoffIso}::timestamptz)
                )
              )
              -- A campaign limited to some senders: a lead pinned to a mailbox outside that list moves to a listed one at once.
              or (
                e.status = 'active' and e.current_step > 0 and e.mailbox_id is distinct from ${mailbox.id}::uuid
                and exists (select 1 from campaign_senders s where s.campaign_id = c.id)
                and not exists (select 1 from campaign_senders s where s.campaign_id = c.id and s.mailbox_id = e.mailbox_id)
              )
            )
            and (
              not exists (select 1 from campaign_senders s where s.campaign_id = c.id)
              or exists (select 1 from campaign_senders s where s.campaign_id = c.id and s.mailbox_id = ${mailbox.id})
            )
            and not exists (
              select 1 from sends s
              where s.enrollment_id = e.id and s.step_number = e.current_step + 1
                and (s.status in ('sending', 'unknown', 'sent') or (s.status = 'failed' and s.attempt >= 3))
            )
            ${exclude}
          order by (e.status = 'active') desc, e.next_send_at asc nulls last, e.current_step desc, e.created_at asc
          limit 1
          for update of e skip locked
        `)) as unknown as CandidateRow[];
        candidate = candidates[0];
        if (!candidate) return null;

        stepNumber = candidate.current_step + 1;
        // Insert is the claim. A failed attempt below the cap is re-claimed in the same statement.
        const claimed = await tx.execute(sql`
          insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id, taken_over_from_mailbox_id, attempt, claimed_at)
          values (${candidate.organization_id}, ${candidate.id}, ${stepNumber}, 'email', 'sending', ${mailbox.id}, ${candidate.taken_over_from}::uuid, 1, ${nowIso}::timestamptz)
          on conflict (enrollment_id, step_number) do update
            set status = 'sending', attempt = sends.attempt + 1, claimed_at = excluded.claimed_at,
                mailbox_id = excluded.mailbox_id, taken_over_from_mailbox_id = excluded.taken_over_from_mailbox_id, error = null, rfc_message_id = null
            where sends.status = 'failed' and sends.attempt < 3
          returning id, attempt
        `);
        claimRow = (claimed as unknown as Array<{ id: string; attempt: number }>)[0];
        if (!claimRow) lost.push(candidate.id);
      }
      if (!claimRow || !candidate) return null;

      // The enrollment is pinned to this mailbox only once the send succeeds (markSent), so a failed first step can retry anywhere.
      await tx
        .update(mailboxes)
        .set({ nextSendAt: new Date(options.now.getTime() + options.pickGapMinutes(emailValues) * 60_000) })
        .where(eq(mailboxes.id, mailbox.id));

      return buildClaim(tx, {
        sendId: claimRow.id,
        attempt: claimRow.attempt,
        stepNumber,
        enrollmentId: candidate.id,
        organizationId: candidate.organization_id,
        campaignId: candidate.campaign_id,
        personId: candidate.person_id,
        takenOverFrom: candidate.taken_over_from,
        mailbox,
      });
    });
  },

  async checkBlockers(claim): Promise<BlockReason | null> {
    // A reply, unsubscribe, bounce or cancel can land between the claim and the send.
    const [enrollment] = await db.select({ status: campaignEnrollments.status }).from(campaignEnrollments).where(eq(campaignEnrollments.id, claim.enrollmentId));
    if (!enrollment || enrollment.status !== "pending" && enrollment.status !== "active") return "enrollment_stopped";

    const [campaign] = await db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, claim.campaignId));
    if (campaign?.status !== "active") return "campaign_inactive";

    const [suppressed] = await db
      .select({ id: suppressionList.id })
      .from(suppressionList)
      .where(and(eq(suppressionList.organizationId, claim.organizationId), eq(suppressionList.email, claim.person.email.toLowerCase())));
    if (suppressed) return "suppressed";

    const [policy] = await db
      .select({ doNotContact: contactPolicies.doNotContact })
      .from(contactPolicies)
      .where(and(eq(contactPolicies.organizationId, claim.organizationId), eq(contactPolicies.personId, claim.person.id)));
    return policy?.doNotContact ? "do_not_contact" : null;
  },

  async abandon(claim, reason, now) {
    await db.transaction(async (tx) => {
      if (reason === "campaign_inactive") {
        // A paused campaign must not burn an attempt: give the attempt back and leave the enrollment as it was.
        await tx
          .update(sends)
          .set({ status: "failed", attempt: sql`greatest(${sends.attempt} - 1, 0)`, error: reason })
          .where(ownClaim(claim));
        return;
      }
      const moved = await tx.update(sends).set({ status: "failed", attempt: 3, error: reason }).where(ownClaim(claim)).returning({ id: sends.id });
      if (moved.length === 0) return;
      // A stopped enrollment keeps the status that stopped it (replied, bounced, ...).
      if (reason === "enrollment_stopped") return;
      await tx
        .update(campaignEnrollments)
        .set({ status: "suppressed", nextSendAt: null, stopReason: reason, updatedAt: now })
        .where(and(eq(campaignEnrollments.id, claim.enrollmentId), inArray(campaignEnrollments.status, LIVE_STATUSES)));
    });
  },

  async recordRendered(claim, rendered) {
    await db
      .update(sends)
      .set({ subject: rendered.subject, body: rendered.body, rfcMessageId: rendered.rfcMessageId })
      .where(ownClaim(claim));
  },

  async markSent(claim, sent, now) {
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(sends)
        .set({ status: "sent", providerMessageId: sent.providerMessageId, threadId: sent.threadId, sentAt: now, error: null })
        .where(ownClaim(claim))
        .returning({ id: sends.id });
      // A send that is already final (for example failed by a reconciler) stays as it is.
      if (moved.length === 0) return;
      await advanceEnrollment(tx, claim.enrollmentId, claim.stepNumber, claim.nextStep?.waitDays ?? null, now, claim.mailbox.id);
    });
  },

  async markFailed(claim, error, now, retryAfterMinutes, maxAttempts) {
    await db.transaction(async (tx) => {
      const moved = await tx.update(sends).set({ status: "failed", error }).where(ownClaim(claim)).returning({ id: sends.id });
      if (moved.length === 0) return;
      await scheduleRetry(tx, claim.enrollmentId, claim.attempt, now, retryAfterMinutes, maxAttempts, error);
    });
  },

  async markUnknown(claim, error) {
    await db.update(sends).set({ status: "unknown", error }).where(ownClaim(claim));
  },

  async listUncertain(olderThan, limit): Promise<UncertainSend[]> {
    const rows = await db
      .select({
        sendId: sends.id,
        organizationId: sends.organizationId,
        enrollmentId: sends.enrollmentId,
        stepNumber: sends.stepNumber,
        attempt: sends.attempt,
        claimedAt: sends.claimedAt,
        rfcMessageId: sends.rfcMessageId,
        mailboxEmail: mailboxes.emailAddress,
        recipientEmail: people.email,
        steps: campaigns.steps,
      })
      .from(sends)
      .innerJoin(mailboxes, eq(mailboxes.id, sends.mailboxId))
      .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
      .innerJoin(people, eq(people.id, campaignEnrollments.personId))
      .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
      // Test sends (kind 'test') have no enrollment and are never reconciled here; the inner join already drops them.
      .where(and(eq(sends.kind, "campaign"), inArray(sends.status, UNRESOLVED), lte(sends.claimedAt, olderThan)))
      .orderBy(asc(sends.claimedAt))
      .limit(limit);
    return rows.map(({ steps, enrollmentId, stepNumber, ...row }) => ({
      ...row,
      enrollmentId: enrollmentId as string,
      stepNumber: stepNumber as number,
      nextStepWaitDays: steps[(stepNumber as number)]?.waitDays ?? null,
    }));
  },

  async resolveUncertainAsSent(send, sent, now) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(sends)
        .set({ status: "sent", providerMessageId: sent.providerMessageId, threadId: sent.threadId, sentAt: now, error: null })
        .where(and(eq(sends.id, send.sendId), canSend("sent")))
        .returning({ id: sends.id, mailboxId: sends.mailboxId });
      if (updated.length === 0) return;
      await advanceEnrollment(tx, send.enrollmentId, send.stepNumber, send.nextStepWaitDays, now, updated[0].mailboxId);
    });
  },

  async resolveUncertainAsNotSent(send, now, retryAfterMinutes, maxAttempts) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(sends)
        .set({ status: "failed", error: "Not found in the mailbox after the grace period." })
        .where(and(eq(sends.id, send.sendId), canSend("failed")))
        .returning({ id: sends.id });
      if (updated.length === 0) return;
      await scheduleRetry(tx, send.enrollmentId, send.attempt, now, retryAfterMinutes, maxAttempts, "Not found in the mailbox.");
    });
  },
};

async function advanceEnrollment(tx: Tx, enrollmentId: string, stepNumber: number, nextWaitDays: number | null, now: Date, mailboxId: string | null) {
  await tx
    .update(campaignEnrollments)
    .set({
      currentStep: stepNumber,
      lastSentAt: now,
      status: nextWaitDays === null ? "completed" : "active",
      nextSendAt: nextWaitDays === null ? null : new Date(now.getTime() + nextWaitDays * 24 * 60 * 60_000),
      ...(mailboxId ? { mailboxId } : {}),
    })
    // Never move backwards: a reconciliation that lands late must not undo a newer step.
    // Compare and set on the status: a reply or unsubscribe that landed meanwhile stays.
    .where(and(eq(campaignEnrollments.id, enrollmentId), inArray(campaignEnrollments.status, LIVE_STATUSES), sql`${campaignEnrollments.currentStep} < ${stepNumber}`));
}

async function scheduleRetry(tx: Tx, enrollmentId: string, attempt: number, now: Date, retryAfterMinutes: number, maxAttempts: number, error: string) {
  if (attempt >= maxAttempts) {
    await tx
      .update(campaignEnrollments)
      .set({ status: "failed", nextSendAt: null, stopReason: `send_failed: ${error}`.slice(0, 500) })
      .where(and(eq(campaignEnrollments.id, enrollmentId), inArray(campaignEnrollments.status, LIVE_STATUSES)));
    return;
  }
  await tx
    .update(campaignEnrollments)
    .set({ nextSendAt: new Date(now.getTime() + retryAfterMinutes * 60_000) })
    .where(and(eq(campaignEnrollments.id, enrollmentId), inArray(campaignEnrollments.status, LIVE_STATUSES)));
}

async function buildClaim(
  tx: Tx,
  input: {
    sendId: string;
    attempt: number;
    stepNumber: number;
    enrollmentId: string;
    organizationId: string;
    campaignId: string;
    personId: string;
    takenOverFrom: string | null;
    mailbox: typeof mailboxes.$inferSelect;
  },
): Promise<SendClaim> {
  const [row] = await tx
    .select({
      email: people.email,
      firstName: people.firstName,
      lastName: people.lastName,
      fullName: people.fullName,
      title: people.title,
      phone: people.phone,
      custom: people.custom,
      companyName: companies.name,
      companyDomain: companies.domain,
      linkedinUrl: people.linkedinUrl,
      raw: people.raw,
      companyLinkedinUrl: companies.linkedinUrl,
      companyRaw: companies.raw,
      steps: campaigns.steps,
      mergeFields: campaignEnrollments.mergeFields,
    })
    .from(campaignEnrollments)
    .innerJoin(people, eq(people.id, campaignEnrollments.personId))
    .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(eq(campaignEnrollments.id, input.enrollmentId));

  const columns = await tx
    .select({ key: entityColumns.key, name: entityColumns.name })
    .from(entityColumns)
    .where(and(eq(entityColumns.organizationId, input.organizationId), eq(entityColumns.entity, "people")));
  const labelByKey = new Map(columns.map((c) => [c.key, c.name]));

  const variables = buildVariables(
    {
      firstName: row.firstName,
      lastName: row.lastName,
      fullName: row.fullName,
      title: row.title,
      phone: row.phone,
      email: row.email,
      companyName: row.companyName,
      companyDomain: row.companyDomain,
      linkedinUrl: row.linkedinUrl,
      raw: row.raw,
      companyLinkedinUrl: row.companyLinkedinUrl,
      companyRaw: row.companyRaw,
      custom: row.custom,
      mergeFields: row.mergeFields,
    },
    labelByKey,
  );

  const priorRows = await tx
    .select({ subject: sends.subject, rfcMessageId: sends.rfcMessageId, threadId: sends.threadId, mailboxId: sends.mailboxId })
    .from(sends)
    .where(and(eq(sends.enrollmentId, input.enrollmentId), eq(sends.status, "sent")))
    .orderBy(asc(sends.stepNumber));
  // Another mailbox cannot continue this mailbox's thread. Keep the subject so a blank-subject follow-up still reads "Re: ...".
  const prior = priorRows.map(({ mailboxId, ...p }) => (mailboxId === input.mailbox.id ? p : { ...p, rfcMessageId: null, threadId: null }));

  const step = row.steps[input.stepNumber - 1];
  const next = row.steps[input.stepNumber];
  return {
    sendId: input.sendId,
    organizationId: input.organizationId,
    attempt: input.attempt,
    stepNumber: input.stepNumber,
    enrollmentId: input.enrollmentId,
    campaignId: input.campaignId,
    mailbox: {
      id: input.mailbox.id,
      emailAddress: input.mailbox.emailAddress,
      displayName: input.mailbox.displayName,
      signatureHtml: input.mailbox.signatureHtml,
    },
    person: { id: input.personId, email: row.email as string, variables },
    step: { subject: step.subject ?? "", body: step.body, waitDays: step.waitDays },
    nextStep: next ? { waitDays: next.waitDays } : null,
    priorSent: prior,
    takenOverFrom: input.takenOverFrom,
  };
}

/**
 * A person settles an email send stuck in `unknown`. The guard is the row lock plus the status check, so
 * two clicks, or a click racing the reconciler, change the send once. `delivered` and `not_delivered`
 * reuse the engine's own `advanceEnrollment` and `scheduleRetry`, so the enrollment ends up exactly as it
 * would after `markSent` or `resolveUncertainAsNotSent`. No provider message id is known for a manual
 * answer, so it stays null (the provider-id unique index ignores nulls).
 */
export async function resolveUnknownEmailSend(input: {
  organizationId: string;
  campaignId: string;
  sendId: string;
  outcome: "delivered" | "not_delivered";
  actorUserId: string;
  now: Date;
  retryDelayMinutes: (attemptJustFailed: number) => number;
  maxAttempts: number;
}): Promise<"resolved" | "not_found" | "not_unknown"> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        status: sends.status,
        enrollmentId: sends.enrollmentId,
        stepNumber: sends.stepNumber,
        attempt: sends.attempt,
        mailboxId: sends.mailboxId,
        steps: campaigns.steps,
      })
      .from(sends)
      .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
      .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
      .where(and(eq(sends.id, input.sendId), eq(sends.organizationId, input.organizationId), eq(sends.channel, "email"), eq(sends.kind, "campaign"), eq(campaigns.id, input.campaignId)))
      .for("update", { of: sends });
    if (!row) return "not_found";
    if (row.status !== "unknown") return "not_unknown";
    // A campaign send always has an enrollment and a step (sends_kind_shape_ck).
    const enrollmentId = row.enrollmentId as string;
    const stepNumber = row.stepNumber as number;

    if (input.outcome === "delivered") {
      await tx
        .update(sends)
        .set({ status: "sent", sentAt: input.now, error: `Confirmed delivered by a person (user ${input.actorUserId}) after checking the Sent folder.` })
        .where(and(eq(sends.id, input.sendId), canSend("sent")));
      await advanceEnrollment(tx, enrollmentId, stepNumber, row.steps[stepNumber]?.waitDays ?? null, input.now, row.mailboxId);
    } else {
      const error = `Marked not delivered by a person (user ${input.actorUserId}) after checking the Sent folder.`;
      await tx.update(sends).set({ status: "failed", error }).where(and(eq(sends.id, input.sendId), canSend("failed")));
      await scheduleRetry(tx, enrollmentId, row.attempt, input.now, input.retryDelayMinutes(row.attempt), input.maxAttempts, "Not delivered, confirmed by a person.");
    }
    return "resolved";
  });
}
