import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, type DbTx } from "@/platform/db/client";
import {
  campaignEnrollments,
  campaigns,
  channelSettings,
  companies,
  entityColumns,
  linkedinAccounts,
  linkedinConnections,
  linkedinEnrollmentDetails,
  people,
  sends,
} from "@/platform/db/schema";
import type {
  LinkedInClaim,
  LinkedInOutreachStore,
  LinkedInResolveClaim,
  LinkedInSendClaim,
  UncertainLinkedInSend,
} from "../application/linkedin-ports";
import {
  MAX_RESOLVE_ATTEMPTS,
  accountBlock,
  dailyInviteLimit,
  inviteBlock,
  linkedinRules,
  nextRunAfter,
  pickMinutes,
  resolveRetryMinutes,
} from "../domain/linkedin";
import { sqlValues } from "@/platform/db/sql-values";
import { readSendPause } from "../../domain/send-pause";
import { ALREADY_CONTACTED_BY_ACCOUNT } from "../../domain/cross-campaign-notice";
import { normalizePublicSlug } from "../domain/linkedin-identity";
import { messageBlock } from "../domain/linkedin-limits";
import { SEND_COUNTED, SEND_UNRESOLVED } from "../../domain/send-status";
import { buildVariables } from "../../domain/variables";
import { enrollmentVariableColumns } from "../../infrastructure/enrollment-variables";
import { countMessagesToday } from "./drizzle-linkedin-account-store";
import { startOfLocalDay, type WorkingHours } from "../../domain/working-hours";
import { failedOutcome, LIVE_ENROLLMENT_STATUSES } from "../../domain/enrollment-status";
import { endEnrollmentsTx } from "../../infrastructure/enrollment-end";
import { giveBackAttempt, ownClaim, readAttempt, reclaimGuard, scheduleRetry, stepTaken } from "../../infrastructure/send-claim-sql";
import { isDoNotContact } from "@/contexts/people/infrastructure/reachability";
import { fillFromLinkedInProfileTx, writeLinkedInSlugTx } from "@/contexts/people/infrastructure/linkedin-profile";
import { disconnectLinkedInAccount, pauseLinkedInAccount } from "./linkedin-account-state";

type Tx = DbTx;

const UNRESOLVED = [...SEND_UNRESOLVED];
/** Statuses an engine write may still change. Anything else (replied, suppressed, removed) stays as it is. */
const LIVE = [...LIVE_ENROLLMENT_STATUSES];

const SLUG_COLLISION_REASON = "This LinkedIn profile already belongs to another lead in your organization.";

const RESOLVE_LEASE_MINUTES = 5;
const DAY_MS = 86_400_000;

interface CandidateRow {
  id: string;
  organization_id: string;
  campaign_id: string;
  person_id: string;
  current_step: number;
}

async function channelValues(tx: Tx, organizationId: string, channel: string): Promise<Record<string, unknown> | null> {
  const [row] = await tx
    .select({ values: channelSettings.values })
    .from(channelSettings)
    .where(and(eq(channelSettings.organizationId, organizationId), eq(channelSettings.channel, channel)));
  return row?.values ?? null;
}

/** Applies the acceptance of one enrollment: connected, and the first message scheduled. Idempotent. Used by the engine and the inbound handler. */
export async function applyAcceptance(tx: Tx, enrollmentId: string, step2WaitDays: number | null, now: Date): Promise<boolean> {
  const changed = await tx
    .update(linkedinEnrollmentDetails)
    .set({ connectionState: "connected", acceptedAt: now })
    .where(and(eq(linkedinEnrollmentDetails.enrollmentId, enrollmentId), sql`${linkedinEnrollmentDetails.connectionState} <> 'connected'`))
    .returning({ id: linkedinEnrollmentDetails.enrollmentId });
  if (changed.length === 0) return false;
  await tx
    .update(campaignEnrollments)
    .set({
      status: step2WaitDays === null ? "completed" : "active",
      currentStep: sql`greatest(${campaignEnrollments.currentStep}, 1)`,
      nextSendAt: step2WaitDays === null ? null : new Date(now.getTime() + step2WaitDays * DAY_MS),
      updatedAt: now,
    })
    .where(and(eq(campaignEnrollments.id, enrollmentId), inArray(campaignEnrollments.status, [...LIVE_ENROLLMENT_STATUSES])));
  return true;
}

async function rememberChat(tx: Tx, organizationId: string, accountId: string, providerId: string, chatId: string | null) {
  if (!chatId) return;
  await tx
    .insert(linkedinConnections)
    .values({ organizationId, linkedinAccountId: accountId, providerId, chatId })
    .onConflictDoUpdate({
      target: [linkedinConnections.providerId, linkedinConnections.linkedinAccountId],
      set: { chatId: sql`coalesce(${linkedinConnections.chatId}, excluded.chat_id)` },
    });
}

/** After a delivered message step: advance, or finish when it was the last one. Never moves backwards. */
async function advanceAfterMessage(tx: Tx, enrollmentId: string, stepNumber: number, nextWaitDays: number | null, now: Date) {
  await tx
    .update(campaignEnrollments)
    .set({
      currentStep: stepNumber,
      lastSentAt: now,
      status: nextWaitDays === null ? "completed" : "active",
      nextSendAt: nextWaitDays === null ? null : new Date(now.getTime() + nextWaitDays * DAY_MS),
      updatedAt: now,
    })
    .where(and(eq(campaignEnrollments.id, enrollmentId), sql`${campaignEnrollments.currentStep} < ${stepNumber}`, inArray(campaignEnrollments.status, [...LIVE_ENROLLMENT_STATUSES])));
}

/** After an invitation went out. Does nothing to the enrollment when the acceptance arrived first. */
async function advanceAfterInvitation(tx: Tx, enrollmentId: string, accountId: string, now: Date) {
  const moved = await tx
    .update(linkedinEnrollmentDetails)
    .set({ connectionState: "request_sent", requestSentAt: now })
    .where(and(eq(linkedinEnrollmentDetails.enrollmentId, enrollmentId), eq(linkedinEnrollmentDetails.connectionState, "none")))
    .returning({ id: linkedinEnrollmentDetails.enrollmentId });
  if (moved.length === 0) return;
  await tx
    .update(campaignEnrollments)
    .set({ status: "active", currentStep: 1, lastSentAt: now, nextSendAt: null, linkedinAccountId: accountId, updatedAt: now })
    .where(and(eq(campaignEnrollments.id, enrollmentId), sql`${campaignEnrollments.currentStep} < 1`, inArray(campaignEnrollments.status, LIVE)));
}

/** A campaign with no assigned senders is open to every account; otherwise only the listed accounts may send for it. */
const senderListed = (accountId: string) => sql`(
  not exists (select 1 from campaign_senders cs where cs.campaign_id = c.id)
  or exists (select 1 from campaign_senders cs where cs.campaign_id = c.id and cs.linkedin_account_id = ${accountId})
)`;

export const drizzleLinkedInStore: LinkedInOutreachStore = {
  async listActionableAccounts(now) {
    return db
      .select({ id: linkedinAccounts.id, organizationId: linkedinAccounts.organizationId })
      .from(linkedinAccounts)
      .where(
        and(
          eq(linkedinAccounts.status, "connected"),
          or(isNull(linkedinAccounts.nextAllowedRunAt), lte(linkedinAccounts.nextAllowedRunAt, now)),
          or(isNull(linkedinAccounts.limitReachedUntil), lte(linkedinAccounts.limitReachedUntil, now)),
        ),
      )
      .orderBy(sql`${linkedinAccounts.nextAllowedRunAt} asc nulls first`);
  },

  async claimNext(options): Promise<LinkedInClaim | null> {
    return db.transaction(async (tx) => {
      const [account] = await tx.select().from(linkedinAccounts).where(eq(linkedinAccounts.id, options.accountId)).for("update", { skipLocked: true });
      if (!account) return null;

      const general = await channelValues(tx, account.organizationId, "general");
      // An owner or admin paused outreach for this organization: claim nothing, like PAUSE_OUTBOUND for one organization.
      if (readSendPause(general)) return null;
      const zoneValue = general?.timeZone;
      const workingHours: WorkingHours = (account.workingHours as WorkingHours | null) ?? options.defaultWorkingHours(typeof zoneValue === "string" ? zoneValue : null);
      if (accountBlock(options.now, { status: account.status, limitReachedUntil: account.limitReachedUntil, nextAllowedRunAt: account.nextAllowedRunAt, workingHours })) return null;

      const rules = linkedinRules(await channelValues(tx, account.organizationId, "linkedin"));
      const nowIso = options.now.toISOString();
      const org = account.organizationId;

      // A person this account already invited through another campaign is not invited again.
      // The subquery aliases its own enrollments as e2, so `campaign_enrollments` names the row being updated.
      await endEnrollmentsTx(
        tx,
        and(
          eq(campaignEnrollments.organizationId, org),
          eq(campaignEnrollments.channel, "linkedin"),
          eq(campaignEnrollments.status, "pending"),
          eq(campaignEnrollments.currentStep, 0),
          eq(campaignEnrollments.linkedinAccountId, account.id),
          sql`exists (
            select 1 from sends s join campaign_enrollments e2 on e2.id = s.enrollment_id
            where e2.person_id = campaign_enrollments.person_id and e2.id <> campaign_enrollments.id and s.linkedin_account_id = ${account.id}
              and s.step_number = 1 and s.status in ${sqlValues(SEND_COUNTED)}
          )`,
        ),
        { status: "suppressed", reason: ALREADY_CONTACTED_BY_ACCOUNT },
        options.now,
      );

      const claimSend = async (kind: "invitation" | "message", gapMinutes: number, candidates: (exclude: ReturnType<typeof sql>) => Promise<CandidateRow[]>) => {
        const lost: string[] = [];
        for (let tries = 0; tries < 5; tries++) {
          const exclude = lost.length ? sql`and e.id not in (${sql.join(lost.map((id) => sql`${id}`), sql`, `)})` : sql``;
          const candidate = (await candidates(exclude))[0];
          if (!candidate) return null;
          const stepNumber = candidate.current_step + 1;
          // Shared with other claims, exclusive against a campaign type change (drizzle-linkedin-campaign-store `update`).
          await tx.execute(sql`select id from campaigns where id = ${candidate.campaign_id} for share`);
          const claimed = await tx.execute(sql`
            insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id, attempt, claimed_at)
            values (${org}, ${candidate.id}, ${stepNumber}, 'linkedin', 'sending', ${account.id}, 1, ${nowIso}::timestamptz)
            on conflict (enrollment_id, step_number) do update
              set status = 'sending', attempt = sends.attempt + 1, claimed_at = excluded.claimed_at,
                  linkedin_account_id = excluded.linkedin_account_id, error = null, rfc_message_id = null
              where ${reclaimGuard}
            returning id, attempt
          `);
          const row = (claimed as unknown as Array<{ id: string; attempt: number }>)[0];
          if (!row) {
            lost.push(candidate.id);
            continue;
          }
          await tx.update(linkedinAccounts).set({ nextAllowedRunAt: nextRunAfter(options.now, gapMinutes) }).where(eq(linkedinAccounts.id, account.id));
          return buildSendClaim(tx, { kind, sendId: row.id, attempt: row.attempt, stepNumber, candidate, account });
        }
        return null;
      };

      // 1. A message that is due. Messages cost no invitation quota, so they go first, inside the account's daily message cap.
      const messageCapReached = messageBlock(await countMessagesToday({ id: account.id, providerAccountId: account.providerAccountId }, options.now, tx), account.dailyMessageLimit) !== null;
      const message = messageCapReached
        ? null
        : await claimSend("message", pickMinutes(rules.messageGapMinutes, options.random), async (exclude) =>
        (await tx.execute(sql`
          select e.id, e.organization_id, e.campaign_id, e.person_id, e.current_step
          from campaign_enrollments e
          join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
          join linkedin_enrollment_details d on d.enrollment_id = e.id
          where e.organization_id = ${org} and e.channel = 'linkedin' and e.status = 'active'
            and e.linkedin_account_id = ${account.id} and d.connection_state = 'connected'
            and c.status = 'active' and e.current_step >= 1 and jsonb_array_length(c.steps) > e.current_step
            and ${senderListed(account.id)}
            and e.next_send_at is not null and e.next_send_at <= ${nowIso}::timestamptz
            and not ${stepTaken(sql`e.current_step + 1`)}
            ${exclude}
          order by e.next_send_at asc
          limit 1
          for update of e skip locked
        `)) as unknown as CandidateRow[],
      );
      if (message) return message;

      // 2. An invitation, inside the daily and weekly limits (claims in flight and unknown outcomes count).
      const startOfDay = startOfLocalDay(options.now, workingHours.timeZone).toISOString();
      const weekAgo = new Date(options.now.getTime() - 7 * DAY_MS).toISOString();
      const [{ today, week }] = await tx
        .select({
          today: sql<number>`(count(*) filter (where ${sends.claimedAt} >= ${startOfDay}::timestamptz))::int`,
          week: sql<number>`count(*)::int`,
        })
        .from(sends)
        .where(and(eq(sends.linkedinAccountId, account.id), eq(sends.stepNumber, 1), eq(sends.channel, "linkedin"), inArray(sends.status, SEND_COUNTED), sql`${sends.claimedAt} >= ${weekAgo}::timestamptz`));
      const limit = dailyInviteLimit({ dailyInviteLimit: account.dailyInviteLimit, isPremium: account.isPremium }, rules);
      if (!inviteBlock({ today, week }, limit, rules.invitesPerWeek)) {
        const invitation = await claimSend("invitation", pickMinutes(rules.inviteGapMinutes, options.random), async (exclude) =>
          (await tx.execute(sql`
            select e.id, e.organization_id, e.campaign_id, e.person_id, e.current_step
            from campaign_enrollments e
            join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
            join linkedin_enrollment_details d on d.enrollment_id = e.id
            where e.organization_id = ${org} and e.channel = 'linkedin' and e.status = 'pending' and e.current_step = 0
              and e.linkedin_account_id = ${account.id} and d.provider_id is not null and d.connection_state = 'none'
              and c.status = 'active' and jsonb_array_length(c.steps) >= 1
              and ${senderListed(account.id)}
              and (e.next_send_at is null or e.next_send_at <= ${nowIso}::timestamptz)
              and not ${stepTaken(sql`1`)}
              ${exclude}
            order by c.created_at asc, e.created_at asc
            limit 1
            for update of e skip locked
          `)) as unknown as CandidateRow[],
        );
        if (invitation) return invitation;
      }

      // 3. A profile to resolve, unless a backlog of resolved people already waits for invitation quota.
      const [{ backlog }] = await tx
        .select({ backlog: sql<number>`count(*)::int` })
        .from(campaignEnrollments)
        .innerJoin(linkedinEnrollmentDetails, eq(linkedinEnrollmentDetails.enrollmentId, campaignEnrollments.id))
        .where(
          and(
            eq(campaignEnrollments.linkedinAccountId, account.id),
            eq(campaignEnrollments.status, "pending"),
            sql`${linkedinEnrollmentDetails.providerId} is not null`,
          ),
        );
      if (backlog >= Math.max(10, limit * 2)) return null;

      const resolvable = (await tx.execute(sql`
        select e.id, p.linkedin_slug, d.profile_url, d.resolve_retry_count
        from campaign_enrollments e
        join campaigns c on c.id = e.campaign_id and c.organization_id = e.organization_id
        join people p on p.id = e.person_id and p.organization_id = e.organization_id
        join linkedin_enrollment_details d on d.enrollment_id = e.id
        where e.organization_id = ${org} and e.channel = 'linkedin' and e.status = 'pending' and e.current_step = 0
          and d.provider_id is null and d.resolve_retry_count < ${MAX_RESOLVE_ATTEMPTS}
          and (d.resolve_next_attempt_at is null or d.resolve_next_attempt_at <= ${nowIso}::timestamptz)
          and (p.linkedin_slug is not null or d.profile_url is not null)
          and c.status = 'active'
          and (e.linkedin_account_id is null or e.linkedin_account_id = ${account.id})
          and ${senderListed(account.id)}
        order by c.created_at asc, e.created_at asc
        limit 1
        for update of e skip locked
      `)) as unknown as Array<{ id: string; linkedin_slug: string | null; profile_url: string | null; resolve_retry_count: number }>;
      const target = resolvable[0];
      if (!target) return null;

      await tx
        .update(linkedinEnrollmentDetails)
        .set({ resolveNextAttemptAt: new Date(options.now.getTime() + RESOLVE_LEASE_MINUTES * 60_000) })
        .where(eq(linkedinEnrollmentDetails.enrollmentId, target.id));
      await tx.update(linkedinAccounts).set({ nextAllowedRunAt: nextRunAfter(options.now, pickMinutes(rules.resolveGapMinutes, options.random)) }).where(eq(linkedinAccounts.id, account.id));
      return {
        kind: "resolve",
        organizationId: org,
        enrollmentId: target.id,
        account: { id: account.id, providerAccountId: account.providerAccountId },
        identifier: (target.linkedin_slug ?? target.profile_url) as string,
        failures: target.resolve_retry_count,
      } satisfies LinkedInResolveClaim;
    });
  },

  async checkBlockers(claim) {
    // A reply, a removal or a suppression can land between the claim and the send.
    const [enrollment] = await db.select({ status: campaignEnrollments.status }).from(campaignEnrollments).where(eq(campaignEnrollments.id, claim.enrollmentId));
    if (!enrollment || !LIVE.includes(enrollment.status as "pending" | "active")) return "enrollment_stopped";
    const [campaign] = await db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, claim.campaignId));
    if (campaign?.status !== "active") return "campaign_inactive";
    return (await isDoNotContact(db, claim.organizationId, claim.person.id)) ? "do_not_contact" : null;
  },

  async abandon(claim, reason, now) {
    await db.transaction(async (tx) => {
      // Nothing reached LinkedIn, so no abandon uses an attempt. A lead restored after a removal sends this step again.
      const moved = await giveBackAttempt(tx, claim, reason);
      // A paused campaign leaves the enrollment as it was. A stopped enrollment keeps the status that stopped it.
      if (moved.length === 0 || reason === "campaign_inactive" || reason === "enrollment_stopped") return;
      await endEnrollmentsTx(tx, eq(campaignEnrollments.id, claim.enrollmentId), { status: "suppressed", reason }, now);
    });
  },

  async recordRendered(claim, rendered) {
    // The marker doubles as the "provider call may have started" flag for reconciliation. Unique per send.
    await db.update(sends).set({ body: rendered.body, rfcMessageId: `li:${claim.sendId}` }).where(ownClaim(claim));
  },

  async markSent(claim, sent, now) {
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(sends)
        .set({ status: "sent", providerMessageId: sent.providerMessageId, threadId: sent.chatId, sentAt: now, error: null })
        .where(ownClaim(claim))
        .returning({ id: sends.id });
      // A send that is already final stays as it is.
      if (moved.length === 0) return;
      if (claim.kind === "invitation") await advanceAfterInvitation(tx, claim.enrollmentId, claim.account.id, now);
      else await advanceAfterMessage(tx, claim.enrollmentId, claim.stepNumber, claim.nextStep?.waitDays ?? null, now);
      await rememberChat(tx, claim.organizationId, claim.account.id, claim.providerId, sent.chatId);
    });
  },

  async markFailed(claim, error, now, retryAfterMinutes, maxAttempts, fatal) {
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(sends)
        .set({ status: "failed", error })
        .where(ownClaim(claim))
        .returning({ id: sends.id });
      if (moved.length === 0) return;
      await scheduleRetry(tx, claim.enrollmentId, claim.attempt, now, retryAfterMinutes, maxAttempts, error, fatal);
    });
  },

  async markUnknown(claim, error) {
    await db.update(sends).set({ status: "unknown", error }).where(ownClaim(claim));
  },

  async release(claim) {
    await giveBackAttempt(db, claim, "released");
  },

  async markAlreadyConnected(claim, now) {
    await db.transaction(async (tx) => {
      // No invitation went out and none is needed: the acceptance moves the enrollment past step 1, so no claim picks this send again.
      const moved = await giveBackAttempt(tx, claim, "already_connected");
      if (moved.length === 0) return;
      await applyAcceptance(tx, claim.enrollmentId, claim.nextStep?.waitDays ?? null, now);
      await tx.update(campaignEnrollments).set({ linkedinAccountId: claim.account.id, updatedAt: now }).where(eq(campaignEnrollments.id, claim.enrollmentId));
    });
  },

  async pauseAccountForLimit(claim, until) {
    await db.transaction(async (tx) => {
      await giveBackAttempt(tx, claim, "limit_reached");
      await pauseLinkedInAccount(tx, claim.account.id, until);
    });
  },

  async disconnectAccount(accountId, error) {
    await disconnectLinkedInAccount(db, accountId, error);
  },

  async markResolved(claim, profile, now) {
    return db.transaction(async (tx) => {
      const [owner] = await tx.select({ personId: campaignEnrollments.personId }).from(campaignEnrollments).where(eq(campaignEnrollments.id, claim.enrollmentId));

      // A resolved public slug goes back to the person, so a Sales Navigator lead becomes a classic lead. A slug that
      // another lead of the organization already holds fails the enrollment and changes neither person (D6).
      const slug = normalizePublicSlug(profile.slug);
      if (slug && (await writeLinkedInSlugTx(tx, claim.organizationId, owner.personId, slug)) === "collision") {
        await tx
          .update(linkedinEnrollmentDetails)
          .set({ resolveRetryCount: MAX_RESOLVE_ATTEMPTS, resolveNextAttemptAt: null, resolveLastError: SLUG_COLLISION_REASON })
          .where(eq(linkedinEnrollmentDetails.enrollmentId, claim.enrollmentId));
        await endEnrollmentsTx(tx, eq(campaignEnrollments.id, claim.enrollmentId), failedOutcome("profile_lookup_failed", SLUG_COLLISION_REASON), now);
        return "slug_collision" as const;
      }

      await tx
        .update(linkedinEnrollmentDetails)
        .set({
          providerId: profile.providerId,
          ...(slug ? { profileUrl: `https://www.linkedin.com/in/${slug}` } : {}),
          resolveRetryCount: 0,
          resolveNextAttemptAt: null,
          resolveLastError: null,
        })
        .where(eq(linkedinEnrollmentDetails.enrollmentId, claim.enrollmentId));
      // The provider id belongs to the account that looked it up, so the lead is pinned to it from here.
      await tx.update(campaignEnrollments).set({ linkedinAccountId: claim.account.id, updatedAt: now }).where(eq(campaignEnrollments.id, claim.enrollmentId));
      await fillFromLinkedInProfileTx(tx, owner.personId, profile);
      return "resolved" as const;
    });
  },

  async markResolveFailed(claim, error, now, fatal) {
    await db.transaction(async (tx) => {
      const failures = claim.failures + 1;
      const exhausted = fatal || failures >= MAX_RESOLVE_ATTEMPTS;
      await tx
        .update(linkedinEnrollmentDetails)
        .set({
          resolveRetryCount: failures,
          resolveLastError: error.slice(0, 500),
          resolveNextAttemptAt: exhausted ? null : new Date(now.getTime() + resolveRetryMinutes(failures) * 60_000),
        })
        .where(eq(linkedinEnrollmentDetails.enrollmentId, claim.enrollmentId));
      if (exhausted) {
        await endEnrollmentsTx(tx, eq(campaignEnrollments.id, claim.enrollmentId), failedOutcome("profile_lookup_failed", error), now);
      }
    });
  },

  async listUncertain(olderThan, limit): Promise<UncertainLinkedInSend[]> {
    const rows = await db
      .select({
        sendId: sends.id,
        organizationId: sends.organizationId,
        enrollmentId: sends.enrollmentId,
        stepNumber: sends.stepNumber,
        attempt: sends.attempt,
        claimedAt: sends.claimedAt,
        marker: sends.rfcMessageId,
        body: sends.body,
        accountId: linkedinAccounts.id,
        providerAccountId: linkedinAccounts.providerAccountId,
        providerId: linkedinEnrollmentDetails.providerId,
        chatId: linkedinConnections.chatId,
        steps: campaigns.steps,
      })
      .from(sends)
      .innerJoin(linkedinAccounts, eq(linkedinAccounts.id, sends.linkedinAccountId))
      .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
      .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
      .innerJoin(linkedinEnrollmentDetails, eq(linkedinEnrollmentDetails.enrollmentId, sends.enrollmentId))
      .leftJoin(
        linkedinConnections,
        and(eq(linkedinConnections.linkedinAccountId, sends.linkedinAccountId), eq(linkedinConnections.providerId, linkedinEnrollmentDetails.providerId)),
      )
      .where(and(eq(sends.channel, "linkedin"), eq(sends.kind, "campaign"), inArray(sends.status, UNRESOLVED), lte(sends.claimedAt, olderThan)))
      .orderBy(asc(sends.claimedAt))
      .limit(limit);
    return rows.map((r) => ({
      sendId: r.sendId,
      organizationId: r.organizationId,
      enrollmentId: r.enrollmentId as string,
      stepNumber: r.stepNumber as number,
      attempt: r.attempt,
      claimedAt: r.claimedAt,
      rendered: r.marker !== null,
      body: r.body,
      chatId: r.chatId,
      account: { id: r.accountId, providerAccountId: r.providerAccountId },
      providerId: r.providerId,
      nextStepWaitDays: r.steps[r.stepNumber as number]?.waitDays ?? null,
    }));
  },

  async resolveUncertainAsSent(send, sent, now) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(sends)
        .set({ status: "sent", providerMessageId: sent.providerMessageId, sentAt: now, error: null })
        .where(readAttempt(send, "sent"))
        .returning({ id: sends.id });
      if (updated.length === 0) return;
      if (send.stepNumber === 1) {
        await advanceAfterInvitation(tx, send.enrollmentId, send.account.id, now);
        if (sent.accepted) await applyAcceptance(tx, send.enrollmentId, send.nextStepWaitDays, now);
      } else {
        await advanceAfterMessage(tx, send.enrollmentId, send.stepNumber, send.nextStepWaitDays, now);
      }
    });
  },

  async resolveUncertainAsNotSent(send, now, retryAfterMinutes, maxAttempts) {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(sends)
        .set({ status: "failed", error: "Not found at LinkedIn after the grace period." })
        .where(readAttempt(send, "failed"))
        .returning({ attempt: sends.attempt });
      if (updated.length === 0) return;
      await scheduleRetry(tx, send.enrollmentId, updated[0].attempt, now, retryAfterMinutes, maxAttempts, "Not found at LinkedIn.", false);
    });
  },

  async expireUnacceptedInvitations(before, now) {
    const expired = await endEnrollmentsTx(
      db,
      and(
        eq(campaignEnrollments.channel, "linkedin"),
        eq(campaignEnrollments.status, "active"),
        sql`exists (
          select 1 from linkedin_enrollment_details d
          where d.enrollment_id = campaign_enrollments.id and d.connection_state = 'request_sent' and d.request_sent_at < ${before.toISOString()}::timestamptz
        )`,
      ),
      { status: "completed", reason: "invite_not_accepted" },
      now,
    );
    return expired.length;
  },
};

async function buildSendClaim(
  tx: Tx,
  input: {
    kind: "invitation" | "message";
    sendId: string;
    attempt: number;
    stepNumber: number;
    candidate: CandidateRow;
    account: typeof linkedinAccounts.$inferSelect;
  },
): Promise<LinkedInSendClaim> {
  const { candidate, account } = input;
  const [row] = await tx
    .select({
      ...enrollmentVariableColumns,
      steps: campaigns.steps,
      providerId: linkedinEnrollmentDetails.providerId,
    })
    .from(campaignEnrollments)
    .innerJoin(people, eq(people.id, campaignEnrollments.personId))
    .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
    .innerJoin(linkedinEnrollmentDetails, eq(linkedinEnrollmentDetails.enrollmentId, campaignEnrollments.id))
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(eq(campaignEnrollments.id, candidate.id));

  const columns = await tx
    .select({ key: entityColumns.key, name: entityColumns.name })
    .from(entityColumns)
    .where(and(eq(entityColumns.organizationId, candidate.organization_id), eq(entityColumns.entity, "people")));
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
    new Map(columns.map((c) => [c.key, c.name])),
  );

  const [connection] = await tx
    .select({ chatId: linkedinConnections.chatId })
    .from(linkedinConnections)
    .where(and(eq(linkedinConnections.linkedinAccountId, account.id), eq(linkedinConnections.providerId, row.providerId as string)));

  const step = row.steps[input.stepNumber - 1];
  const next = row.steps[input.stepNumber];
  return {
    kind: input.kind,
    sendId: input.sendId,
    organizationId: candidate.organization_id,
    attempt: input.attempt,
    stepNumber: input.stepNumber,
    enrollmentId: candidate.id,
    campaignId: candidate.campaign_id,
    account: { id: account.id, providerAccountId: account.providerAccountId },
    person: { id: candidate.person_id, variables },
    providerId: row.providerId as string,
    chatId: connection?.chatId ?? null,
    step: { body: step.body, waitDays: step.waitDays },
    nextStep: next ? { waitDays: next.waitDays } : null,
  };
}
