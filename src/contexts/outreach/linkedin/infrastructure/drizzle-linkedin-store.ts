import type { SendResolutionStore } from "../../application/send-resolution";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
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
  linkedinOpenOperations,
  people,
  sends,
} from "@/platform/db/schema";
import type {
  LinkedInClaim,
  LinkedInOutreachStore,
  LinkedInReplyCheckClaim,
  LinkedInResolveClaim,
  LinkedInSendClaim,
  SettledLinkedInSend,
  UncertainLinkedInSend,
  LinkedInEngineDeps,
} from "../application/linkedin-ports";
import {
  MAX_RESOLVE_ATTEMPTS,
  accountBlock,
  afterResolveFailure,
  dailyInviteLimit,
  inboundIsStale,
  invitationsHeld,
  inviteBlock,
  linkedinRules,
  lookupBacklogFull,
  nextRunAfter,
  pickMinutes,
  profileUrlFor,
} from "../domain/linkedin";
import { sqlValues } from "@/platform/db/sql-values";
import { INTERRUPTED_BEFORE_PROVIDER } from "../../domain/send-policy";
import { readSendPause } from "../../domain/send-pause";
import { ALREADY_CONTACTED_BY_ACCOUNT } from "../../domain/cross-campaign-notice";
import { normalizePublicSlug } from "../domain/linkedin-identity";
import { messageBlock } from "../domain/linkedin-limits";
import type { ContactStop } from "../../application/inbound-ports";
import { SEND_COUNTED, SEND_UNRESOLVED } from "../../domain/send-status";
import { buildVariables } from "../../domain/variables";
import { enrollmentVariableColumns } from "../../infrastructure/enrollment-variables";
import { startOfLocalDay, type WorkingHours } from "../../domain/working-hours";
import { failedOutcome, isLiveEnrollment, LIVE_ENROLLMENT_STATUSES } from "../../domain/enrollment-status";
import { endEnrollmentsTx } from "../../infrastructure/enrollment-end";
import { deferUncertainCheck, giveBackAttempt, ownClaim, readAttempt, reclaimGuard, scheduleRetry, stepTaken, uncertainDue, uncertainOrder } from "../../infrastructure/send-claim-sql";
import { isDoNotContact, isLinkedinBlockedBySuppression } from "@/contexts/people/infrastructure/reachability";
import { fillFromLinkedInProfileTx, writeLinkedInSlugTx } from "@/contexts/people/infrastructure/linkedin-profile";
import { countMessagesToday, disconnectLinkedInAccount, pauseLinkedInAccount } from "./linkedin-account-state";
import { advanceAfterInvitation, advanceAfterMessage, applyAcceptance } from "./linkedin-enrollment-progress";
import { accountHasOpenOperation, insertOpenOperation, replyCheckSince } from "./drizzle-linkedin-open-operations-store";
import { VENDORS_READ_BY_POLL } from "./linkedin-vendor-facts";

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
      // A vendor with no webhook for messages: a stop request may be unread, or the read may be failing. Nothing goes out on old news.
      if (VENDORS_READ_BY_POLL.includes(account.provider) && inboundIsStale(options.now, account.inboundReadAt)) return null;
      // The vendor runs one action at a time, so another would only wait behind this one, and a stop could not reach it.
      if (await accountHasOpenOperation(tx, account.id)) return null;

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
          const claimed = await tx.execute(sql`
            insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id, attempt, claimed_at)
            values (${org}, ${candidate.id}, ${stepNumber}, 'linkedin', 'sending', ${account.id}, 1, ${nowIso}::timestamptz)
            on conflict (enrollment_id, step_number) do update
              set status = 'sending', attempt = sends.attempt + 1, claimed_at = excluded.claimed_at,
                  linkedin_account_id = excluded.linkedin_account_id, error = null, rfc_message_id = null, next_check_at = null
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
      const dueMessages = async (only: ReturnType<typeof sql>) =>
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
            ${only}
          order by e.next_send_at asc
          limit 1
          for update of e skip locked
        `)) as unknown as CandidateRow[];

      // A reply written while this account was gone was never read, so the lead's thread is read before the message that would answer past it.
      if (account.inboxGapUntil && !messageCapReached) {
        const [unread] = await dueMessages(sql`and (d.reply_checked_at is null or d.reply_checked_at < ${account.inboxGapUntil.toISOString()}::timestamptz)`);
        if (unread) {
          await tx.update(linkedinAccounts).set({ nextAllowedRunAt: nextRunAfter(options.now, pickMinutes(rules.messageGapMinutes, options.random)) }).where(eq(linkedinAccounts.id, account.id));
          return replyCheckClaim(tx, unread, account, options.now);
        }
      }

      // A row another worker held above was skipped there, so this query keeps the same rule rather than take it unread.
      const readSinceGap = account.inboxGapUntil ? sql`and d.reply_checked_at >= ${account.inboxGapUntil.toISOString()}::timestamptz` : sql``;
      const message = messageCapReached ? null : await claimSend("message", pickMinutes(rules.messageGapMinutes, options.random), (exclude) => dueMessages(sql`${readSinceGap} ${exclude}`));
      if (message) return message;

      // 2. An invitation, inside the daily and weekly limits (claims in flight and unknown outcomes count).
      if (invitationsHeld(account, options.now)) return null;
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
      if (lookupBacklogFull(backlog, limit)) return null;

      const resolvable = (await tx.execute(sql`
        select e.id, p.linkedin_slug, d.profile_url, d.resolve_retry_count, d.resolve_next_api
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
          and not exists (select 1 from linkedin_open_operations o where o.kind = 'lookup' and o.subject_id = e.id)
          -- A fallback stays on the account whose classic lookup led to it, while that account can still run it.
          and (d.resolve_next_account is null or d.resolve_next_account = ${account.id}
            or not exists (select 1 from linkedin_accounts next_a where next_a.id = d.resolve_next_account and next_a.status = 'connected'))
        order by c.created_at asc, e.created_at asc
        limit 1
        for update of e skip locked
      `)) as unknown as Array<{ id: string; linkedin_slug: string | null; profile_url: string | null; resolve_retry_count: number; resolve_next_api: "sales_navigator" | "recruiter" | null }>;
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
        nextApi: target.resolve_next_api,
      } satisfies LinkedInResolveClaim;
    });
  },

  async checkBlockers(claim) {
    // A reply, a removal or a suppression can land between the claim and the send.
    const [enrollment] = await db.select({ status: campaignEnrollments.status }).from(campaignEnrollments).where(eq(campaignEnrollments.id, claim.enrollmentId));
    if (!enrollment || !isLiveEnrollment(enrollment.status)) return "enrollment_stopped";
    const [campaign] = await db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, claim.campaignId));
    if (campaign?.status !== "active") return "campaign_inactive";
    if (await isLinkedinBlockedBySuppression(db, claim.organizationId, claim.person.id)) return "suppressed";
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
    const moved = await db.update(sends).set({ body: rendered.body, rfcMessageId: `li:${claim.sendId}` }).where(ownClaim(claim)).returning({ id: sends.id });
    return moved.length > 0;
  },

  async markSent(claim, sent, now) {
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(sends)
        .set({ status: "sent", providerMessageId: sent.providerMessageId, providerThreadId: sent.chatId, sentAt: now, error: null })
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

  async pauseAccountForLookupLimit(claim, until) {
    await pauseLinkedInAccount(db, claim.account.id, until);
  },

  async pauseInvitationsForLimit(claim, until) {
    await db.transaction(async (tx) => {
      await giveBackAttempt(tx, claim, "limit_reached");
      await tx.update(linkedinAccounts).set({ invitesPausedUntil: until }).where(eq(linkedinAccounts.id, claim.account.id));
    });
  },

  async pauseInvitationsForLookupLimit(claim, until) {
    await db.update(linkedinAccounts).set({ invitesPausedUntil: until }).where(eq(linkedinAccounts.id, claim.account.id));
  },

  async holdRecipient(claim, until, error, now) {
    await db.transaction(async (tx) => {
      const moved = await giveBackAttempt(tx, claim, error);
      if (moved.length === 0) return;
      await tx.update(campaignEnrollments).set({ nextSendAt: until, updatedAt: now }).where(and(eq(campaignEnrollments.id, claim.enrollmentId), inArray(campaignEnrollments.status, LIVE)));
    });
  },

  async disconnectAccount(accountId, error) {
    await disconnectLinkedInAccount(db, accountId, error);
  },

  async noteSubmitted(input) {
    await insertOpenOperation(db, input);
  },

  async moveResolveToApi(claim, api, now) {
    await db.update(linkedinEnrollmentDetails).set({ resolveNextApi: api, resolveNextAccount: claim.account.id, resolveNextAttemptAt: now }).where(eq(linkedinEnrollmentDetails.enrollmentId, claim.enrollmentId));
  },

  async resolveBySlug(claim, slug, now) {
    await db.transaction(async (tx) => {
      const [owner] = await tx.select({ personId: campaignEnrollments.personId, status: campaignEnrollments.status }).from(campaignEnrollments).where(eq(campaignEnrollments.id, claim.enrollmentId));
      if (!owner || !isLiveEnrollment(owner.status)) return;
      const normalized = normalizePublicSlug(slug);
      if (normalized && (await writeLinkedInSlugTx(tx, claim.organizationId, owner.personId, normalized)) === "collision") {
        await failForSlugCollision(tx, claim.enrollmentId, now);
        return;
      }
      await tx.update(linkedinEnrollmentDetails).set({ resolveNextApi: null, resolveNextAccount: null, resolveNextAttemptAt: now }).where(eq(linkedinEnrollmentDetails.enrollmentId, claim.enrollmentId));
    });
  },

  async markReplyChecked(enrollmentId, now) {
    await db.update(linkedinEnrollmentDetails).set({ replyCheckedAt: now }).where(eq(linkedinEnrollmentDetails.enrollmentId, enrollmentId));
  },

  async deferReplyCheck(enrollmentId, until) {
    await db.update(campaignEnrollments).set({ nextSendAt: until }).where(and(eq(campaignEnrollments.id, enrollmentId), inArray(campaignEnrollments.status, LIVE)));
  },

  async markResolved(claim, profile, now) {
    return db.transaction(async (tx) => {
      const [owner] = await tx.select({ personId: campaignEnrollments.personId, status: campaignEnrollments.status }).from(campaignEnrollments).where(eq(campaignEnrollments.id, claim.enrollmentId));
      // A lead that stopped while the lookup ran stays as it stopped, not pinned to this account.
      if (!owner || !isLiveEnrollment(owner.status)) return "stopped" as const;

      // A resolved public slug goes back to the person, so a Sales Navigator lead becomes a classic lead. A slug that
      // another lead of the organization already holds fails the enrollment and changes neither person (D6).
      const slug = normalizePublicSlug(profile.slug);
      if (slug && (await writeLinkedInSlugTx(tx, claim.organizationId, owner.personId, slug)) === "collision") {
        await failForSlugCollision(tx, claim.enrollmentId, now);
        return "slug_collision" as const;
      }

      await tx
        .update(linkedinEnrollmentDetails)
        .set({
          providerId: profile.providerId,
          ...(slug ? { profileUrl: profileUrlFor(slug) } : {}),
          ...(profile.memberUrn ? { memberUrn: profile.memberUrn } : {}),
          resolveRetryCount: 0,
          resolveNextAttemptAt: null,
          resolveNextApi: null,
          resolveNextAccount: null,
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
      const { exhausted, nextAttemptAt } = afterResolveFailure(failures, fatal, now);
      await tx
        .update(linkedinEnrollmentDetails)
        .set({
          resolveRetryCount: failures,
          resolveLastError: error.slice(0, 500),
          resolveNextAttemptAt: nextAttemptAt,
          resolveNextApi: null,
          resolveNextAccount: null,
        })
        .where(eq(linkedinEnrollmentDetails.enrollmentId, claim.enrollmentId));
      if (exhausted) {
        await endEnrollmentsTx(tx, eq(campaignEnrollments.id, claim.enrollmentId), failedOutcome("profile_lookup_failed", error), now);
      }
    });
  },

  async deferUncertain(sendId, until) {
    await deferUncertainCheck(db, sendId, until);
  },

  async listUncertain(olderThan, limit, now): Promise<UncertainLinkedInSend[]> {
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
        slug: people.linkedinSlug,
        steps: campaigns.steps,
      })
      .from(sends)
      .innerJoin(linkedinAccounts, eq(linkedinAccounts.id, sends.linkedinAccountId))
      .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
      .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
      .innerJoin(people, eq(people.id, campaignEnrollments.personId))
      .innerJoin(linkedinEnrollmentDetails, eq(linkedinEnrollmentDetails.enrollmentId, sends.enrollmentId))
      .leftJoin(
        linkedinConnections,
        and(eq(linkedinConnections.linkedinAccountId, sends.linkedinAccountId), eq(linkedinConnections.providerId, linkedinEnrollmentDetails.providerId)),
      )
      .where(and(eq(sends.channel, "linkedin"), eq(sends.kind, "campaign"), inArray(sends.status, UNRESOLVED), lte(sends.claimedAt, olderThan), uncertainDue(now), notAwaitingVendor))
      .orderBy(uncertainOrder)
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
      slug: r.slug,
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

  async resolveUncertainAsNotSent(send, now, retryAfterMinutes, maxAttempts, cause) {
    const reason = cause === "interrupted" ? INTERRUPTED_BEFORE_PROVIDER : "Not found at LinkedIn.";
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(sends)
        .set({ status: "failed", error: cause === "interrupted" ? INTERRUPTED_BEFORE_PROVIDER : "Not found at LinkedIn after the grace period." })
        .where(readAttempt(send, "failed"))
        .returning({ attempt: sends.attempt });
      if (updated.length === 0) return;
      await scheduleRetry(tx, send.enrollmentId, updated[0].attempt, now, retryAfterMinutes, maxAttempts, reason, false);
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

/** A slug another lead of the organization holds fails the enrollment and changes neither person (D6). */
async function failForSlugCollision(tx: Tx, enrollmentId: string, now: Date) {
  await tx
    .update(linkedinEnrollmentDetails)
    .set({ resolveRetryCount: MAX_RESOLVE_ATTEMPTS, resolveNextAttemptAt: null, resolveNextApi: null, resolveNextAccount: null, resolveLastError: SLUG_COLLISION_REASON })
    .where(eq(linkedinEnrollmentDetails.enrollmentId, enrollmentId));
  await endEnrollmentsTx(tx, eq(campaignEnrollments.id, enrollmentId), failedOutcome("profile_lookup_failed", SLUG_COLLISION_REASON), now);
}

/** A vendor still runs this send, so there is nothing to look for yet. The settle job has it. */
const notAwaitingVendor = sql`not (${sends.status} = 'sending' and exists (select 1 from linkedin_open_operations o where o.subject_id = ${sends.id} and o.kind in ('invitation', 'message')))`;

async function replyCheckClaim(tx: Tx, candidate: CandidateRow, account: typeof linkedinAccounts.$inferSelect, now: Date): Promise<LinkedInReplyCheckClaim> {
  const [row] = await tx
    .select({ providerId: linkedinEnrollmentDetails.providerId, acceptedAt: linkedinEnrollmentDetails.acceptedAt, slug: people.linkedinSlug, started: sql<Date | null>`(select min(s.claimed_at) from sends s where s.enrollment_id = ${candidate.id})` })
    .from(linkedinEnrollmentDetails)
    .innerJoin(people, eq(people.id, sql`${candidate.person_id}::uuid`))
    .where(eq(linkedinEnrollmentDetails.enrollmentId, candidate.id));
  const [connection] = await tx
    .select({ chatId: linkedinConnections.chatId })
    .from(linkedinConnections)
    .where(and(eq(linkedinConnections.linkedinAccountId, account.id), eq(linkedinConnections.providerId, row.providerId as string)));
  return {
    kind: "reply_check",
    organizationId: candidate.organization_id,
    enrollmentId: candidate.id,
    account: { id: account.id, providerAccountId: account.providerAccountId },
    to: { chat: connection?.chatId ?? null, member: row.providerId, slug: row.slug },
    since: replyCheckSince(row.started ? new Date(row.started) : row.acceptedAt, now),
  };
}

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
      acceptedAt: linkedinEnrollmentDetails.acceptedAt,
      slug: people.linkedinSlug,
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

  // Only a message checks the thread, and an invitation has no earlier step.
  const [started] =
    input.kind === "message"
      ? await tx
          .select({ at: sql<Date | null>`min(${sends.claimedAt})` })
          .from(sends)
          .where(and(eq(sends.enrollmentId, candidate.id), lt(sends.stepNumber, input.stepNumber), inArray(sends.status, SEND_COUNTED)))
      : [];
  const outreachStartedAt = started?.at ? new Date(started.at) : row.acceptedAt;

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
    slug: row.slug,
    step: { body: step.body, waitDays: step.waitDays },
    nextStep: next ? { waitDays: next.waitDays } : null,
    outreachStartedAt,
  };
}

/**
 * A person's call on a LinkedIn send nobody could settle. The same writes as the reconciler's, guarded on the attempt it read,
 * so a reconciler that settled it first keeps its result.
 */
export const drizzleLinkedInSendResolutionStore: SendResolutionStore = {
  async resolve(input) {
    const [row] = await db
      .select({
        status: sends.status,
        enrollmentId: sends.enrollmentId,
        stepNumber: sends.stepNumber,
        attempt: sends.attempt,
        accountId: sends.linkedinAccountId,
        steps: campaigns.steps,
      })
      .from(sends)
      .innerJoin(campaignEnrollments, eq(campaignEnrollments.id, sends.enrollmentId))
      .innerJoin(campaigns, eq(campaigns.id, campaignEnrollments.campaignId))
      .where(and(eq(sends.id, input.sendId), eq(sends.organizationId, input.organizationId), eq(sends.channel, "linkedin"), eq(sends.kind, "campaign"), eq(campaignEnrollments.campaignId, input.campaignId)));
    if (!row) return "not_found";
    if (row.status !== "unknown") return "not_unknown";
    const [open] = await db.select({ id: linkedinOpenOperations.id }).from(linkedinOpenOperations).where(eq(linkedinOpenOperations.subjectId, input.sendId));
    if (open) return "not_unknown";
    const stepNumber = row.stepNumber as number;
    const send: SettledLinkedInSend = {
      sendId: input.sendId,
      enrollmentId: row.enrollmentId as string,
      stepNumber,
      attempt: row.attempt,
      account: { id: row.accountId as string },
      nextStepWaitDays: (row.steps as Array<{ waitDays?: number }>)[stepNumber]?.waitDays ?? null,
    };
    if (input.outcome === "delivered") await drizzleLinkedInStore.resolveUncertainAsSent(send, { providerMessageId: null, accepted: false }, input.now);
    else await drizzleLinkedInStore.resolveUncertainAsNotSent(send, input.now, input.retryDelayMinutes(row.attempt), input.maxAttempts, "not_found");
    return "resolved";
  },
};

/** Conversations owns the stop, so it is passed in. The stop takes the person's locks first, and the send's row follows. */
export const createLinkedInReplyStop = (stop: ContactStop): LinkedInEngineDeps["stopForReply"] => (claim, now) =>
  db.transaction(async (tx) => {
    await stop.stopContactTx(tx, { organizationId: claim.organizationId, personId: claim.person.id }, { kind: "reply", channel: "linkedin", now });
    await giveBackAttempt(tx, claim, "replied");
  });
