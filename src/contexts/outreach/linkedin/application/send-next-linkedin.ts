import { BARE_SLUG } from "@/contexts/people/domain/linkedin-slug";
import { isOutboundPaused } from "@/shared/outbound-pause";
import {
  INVITE_EXPIRES_DAYS,
  LIMIT_PAUSE_HOURS,
  inviteNoteProblem,
  inviteRetryMinutes,
  renderLinkedInText,
} from "../domain/linkedin";
import { parseLinkedInProfileRef } from "../domain/linkedin-identity";
import { MAX_SEND_ATTEMPTS, NOT_FOUND_GRACE_MINUTES, UNCERTAIN_AFTER_MINUTES, UNCERTAIN_RECHECK_MINUTES } from "../../domain/send-policy";
import { defaultWorkingHours } from "../../domain/working-hours";
import { REPLY_CHECK_RETRY_MINUTES } from "../domain/linkedin-operations";
import {
  LinkedInGatewayError,
  isSubmitted,
  type GatewayProfile,
  type LinkedInClaim,
  type LinkedInEngineDeps,
  type LinkedInGateway,
  type LinkedInReplyCheckClaim,
  type LinkedInResolveClaim,
  type LinkedInSendClaim,
  type LinkedInSettleClaim,
  type SubmittedOperation,
} from "./linkedin-ports";

export type LinkedInOutcome =
  | { kind: "idle" }
  | { kind: "sent"; what: "invitation" | "message" }
  | { kind: "resolved" }
  | { kind: "resolve_failed" }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; retry: boolean }
  | { kind: "paused"; reason: "limit" | "disconnected" | "no_gateway" }
  | { kind: "unknown" }
  /** The vendor took it and runs it later. `linkedin.settle-operations` writes the outcome. */
  | { kind: "submitted" }
  /** The claim was lost before the provider call (a reconcile or another worker took the send). Nothing went out. */
  | { kind: "dropped" };

const FALLBACK_ZONE = "UTC";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Claims and performs at most one unit of work (message, invitation or profile lookup) for one account. */
export async function runNextLinkedInAction(deps: LinkedInEngineDeps, accountId: string): Promise<LinkedInOutcome> {
  // PAUSE_OUTBOUND is read per call: while set, nothing is claimed (no message, invitation or profile lookup).
  if (isOutboundPaused()) return { kind: "idle" };
  const now = deps.clock.now();
  const claim = await deps.store.claimNext({
    accountId,
    now,
    random: deps.random,
    defaultWorkingHours: (zone) => defaultWorkingHours(zone ?? FALLBACK_ZONE),
  });
  if (!claim) return { kind: "idle" };

  const gateway = await deps.gateways.forAccount({ organizationId: claim.organizationId, accountId: claim.account.id });
  if (claim.kind === "resolve") {
    if (!gateway) return { kind: "paused", reason: "no_gateway" };
    return resolve(deps, gateway, claim);
  }
  if (claim.kind === "reply_check") {
    if (!gateway) return { kind: "paused", reason: "no_gateway" };
    return startReplyCheck(deps, gateway, claim);
  }
  if (!gateway) {
    // LinkedIn was disconnected between the claim and the call. Nothing went out: give the attempt back.
    await deps.store.disconnectAccount(claim.account.id, "LinkedIn is not connected for this organization.");
    await deps.store.release(claim);
    return { kind: "paused", reason: "no_gateway" };
  }
  return deliver(deps, gateway, claim);
}

export const NO_PREMIUM_ACCESS = "This LinkedIn account has no Sales Navigator or Recruiter access, and the member could not be found with a standard lookup.";
const UNREADABLE_PROFILE = "This LinkedIn URL does not identify a person profile.";

/** What the lookup sends: a slug or URL goes through as stored (classic), a member id goes with its API.
 * `linkedinApi` is not sent on the first call. It marks the Sales Navigator or Recruiter fallback that `lookupProfile` may try next. */
export function lookupInput(identifier: string): { identifier: string; linkedinApi?: "sales_navigator" | "recruiter"; memberId?: string } | null {
  const ref = parseLinkedInProfileRef(identifier);
  if (ref?.kind === "member") {
    return { identifier: ref.memberId, memberId: ref.memberId, ...(ref.api === "classic" ? {} : { linkedinApi: ref.api }) };
  }
  if (ref) return { identifier };
  // Stored text that is not a profile or member URL. A bare slug-like value keeps the classic path.
  return BARE_SLUG.test(identifier) ? { identifier } : null;
}

/** Definite answers to the classic lookup after which a Sales Navigator or Recruiter lookup can still succeed. */
const FALLBACK_AFTER: ReadonlySet<string> = new Set(["not_found", "rejected", "invalid_recipient", "insufficient_privileges"]);

/** Whether a classic lookup's failure leaves a lookup on the lead's own product worth trying. */
export const fallsBackToApi = (error: unknown): error is LinkedInGatewayError => error instanceof LinkedInGatewayError && error.kind === "definite" && FALLBACK_AFTER.has(error.code);

type LookupResult = { ok: true; profile: GatewayProfile } | { ok: false; reason: "no_access" } | { ok: "submitted"; submitted: SubmittedOperation; api: "sales_navigator" | "recruiter" | null };

function lookupAnswer(answer: GatewayProfile | SubmittedOperation, api: "sales_navigator" | "recruiter" | null): LookupResult {
  return isSubmitted(answer) ? { ok: "submitted", submitted: answer, api } : { ok: true, profile: answer };
}

/**
 * Looks a member up. The first call carries no linkedin_api. For a Sales Navigator or Recruiter reference, a definite
 * answer other than auth or rate_limited (see FALLBACK_AFTER) earns one retry with linkedin_api. An out-of-scope answer to
 * that retry means the account has no such product: `no_access`. Everything else throws: auth, rate_limited and unknown
 * outcomes on either call, and any other definite failure of the retry.
 */
async function lookupProfile(gateway: LinkedInGateway, account: string, lookup: { identifier: string; linkedinApi?: "sales_navigator" | "recruiter" }, nextApi: "sales_navigator" | "recruiter" | null): Promise<LookupResult> {
  // A vendor's classic lookup already finished without a person, so this claim goes straight to the product.
  const api = nextApi ?? lookup.linkedinApi;
  if (!nextApi) {
    try {
      return lookupAnswer(await gateway.getProfile({ account, identifier: lookup.identifier }), null);
    } catch (first) {
      if (!lookup.linkedinApi || !fallsBackToApi(first)) throw first;
    }
  }
  try {
    return lookupAnswer(await gateway.getProfile({ account, identifier: lookup.identifier, linkedinApi: api }), api ?? null);
  } catch (second) {
    if (second instanceof LinkedInGatewayError && second.code === "insufficient_privileges") return { ok: false, reason: "no_access" };
    throw second;
  }
}

async function resolve(deps: LinkedInEngineDeps, gateway: LinkedInGateway, claim: LinkedInResolveClaim): Promise<LinkedInOutcome> {
  try {
    const lookup = lookupInput(claim.identifier);
    if (!lookup) {
      await deps.store.markResolveFailed(claim, UNREADABLE_PROFILE, deps.clock.now(), true);
      return { kind: "resolve_failed" };
    }
    // The classic lookup by member id comes first (live check 2026-10-15, on a classic-only account only: it resolved the id
    // there; a Sales Navigator account was not checked). The Sales Navigator or Recruiter lookup is the fallback.
    const found = await lookupProfile(gateway, claim.account.providerAccountId, lookup, claim.nextApi);
    if (found.ok === "submitted") {
      await deps.store.noteSubmitted({ kind: "lookup", subjectId: claim.enrollmentId, organizationId: claim.organizationId, account: claim.account, operation: found.submitted.operation, api: found.api, now: deps.clock.now() });
      return { kind: "submitted" };
    }
    if (!found.ok) return lookupWithoutAccess(deps, claim);
    return await writeLookup(deps, claim, found.profile, lookup.memberId);
  } catch (error) {
    return handleLookupError(deps, claim, error);
  }
}

/** The account is healthy. It lacks the product, so the lead may resolve later (the plan can change) and retries with backoff. */
export async function lookupWithoutAccess(deps: LinkedInEngineDeps, claim: LinkedInResolveClaim): Promise<LinkedInOutcome> {
  await deps.store.markResolveFailed(claim, NO_PREMIUM_ACCESS, deps.clock.now(), false);
  return { kind: "resolve_failed" };
}

export async function writeLookup(deps: LinkedInEngineDeps, claim: LinkedInResolveClaim, profile: GatewayProfile, memberId: string | undefined): Promise<LinkedInOutcome> {
  const written = await deps.store.markResolved(
    claim,
    {
      providerId: profile.member,
      slug: profile.publicSlug,
      firstName: profile.firstName,
      lastName: profile.lastName,
      headline: profile.headline,
      pictureUrl: profile.pictureUrl,
      ...(memberId ? { memberId } : {}),
      ...(profile.memberUrn ? { memberUrn: profile.memberUrn } : {}),
    },
    deps.clock.now(),
  );
  return written === "slug_collision" ? { kind: "resolve_failed" } : written === "stopped" ? { kind: "dropped" } : { kind: "resolved" };
}

export async function handleLookupError(deps: LinkedInEngineDeps, claim: LinkedInResolveClaim, error: unknown): Promise<LinkedInOutcome> {
  const code = error instanceof LinkedInGatewayError ? error.code : null;
  if (code === "auth") {
    await deps.store.disconnectAccount(claim.account.id, errorText(error));
    return { kind: "paused", reason: "disconnected" };
  }
  if (code === "rate_limited") {
    const limit = error as LinkedInGatewayError;
    if (limit.limits === "invitations") await deps.store.pauseInvitationsForLookupLimit(claim, pausedUntil(limit, deps.clock.now()));
    else await deps.store.pauseAccountForLookupLimit(claim, pausedUntil(limit, deps.clock.now()));
    return { kind: "paused", reason: "limit" };
  }
  // A lookup changes nothing at the provider, so every failure is safe to retry later.
  await deps.store.markResolveFailed(claim, errorText(error), deps.clock.now(), code === "not_found" || code === "invalid_recipient");
  return { kind: "resolve_failed" };
}

/** Asks the vendor to read this lead's thread before its next message. Until a look finishes, nothing goes out to the lead. */
async function startReplyCheck(deps: LinkedInEngineDeps, gateway: LinkedInGateway, claim: LinkedInReplyCheckClaim): Promise<LinkedInOutcome> {
  const now = deps.clock.now();
  // Only a vendor with operations leaves such a gap, and one that stopped being this account's vendor has no way to look.
  if (!gateway.operations) {
    await deps.store.deferReplyCheck(claim.enrollmentId, new Date(now.getTime() + REPLY_CHECK_RETRY_MINUTES * 60_000));
    return { kind: "paused", reason: "no_gateway" };
  }
  try {
    const { operation } = await gateway.operations.checkThread({ account: claim.account.providerAccountId, to: claim.to, since: claim.since });
    await deps.store.noteSubmitted({ kind: "reply_check", subjectId: claim.enrollmentId, organizationId: claim.organizationId, account: claim.account, operation, now });
    return { kind: "submitted" };
  } catch (error) {
    return handleReplyCheckError(deps, claim, error);
  }
}

export async function handleReplyCheckError(deps: LinkedInEngineDeps, claim: LinkedInReplyCheckClaim, error: unknown): Promise<LinkedInOutcome> {
  const now = deps.clock.now();
  if (error instanceof LinkedInGatewayError && error.kind === "definite") {
    if (error.code === "auth") {
      await deps.store.disconnectAccount(claim.account.id, errorText(error));
      return { kind: "paused", reason: "disconnected" };
    }
    if (error.code === "rate_limited") {
      await deps.store.pauseAccountForLookupLimit(claim, pausedUntil(error, now));
      return { kind: "paused", reason: "limit" };
    }
  }
  await deps.store.deferReplyCheck(claim.enrollmentId, new Date(now.getTime() + REPLY_CHECK_RETRY_MINUTES * 60_000));
  return { kind: "blocked", reason: "reply_check_failed" };
}

async function deliver(deps: LinkedInEngineDeps, gateway: LinkedInGateway, claim: LinkedInSendClaim): Promise<LinkedInOutcome> {
  const blocked = await deps.store.checkBlockers(claim);
  if (blocked) {
    await deps.store.abandon(claim, blocked, deps.clock.now());
    return { kind: "blocked", reason: blocked };
  }

  const text = renderLinkedInText(claim.step.body, claim.person.variables, deps.random);
  if (claim.kind === "invitation") {
    const problem = inviteNoteProblem(text);
    if (problem) {
      // Cutting a note would change what the author wrote. Fail this lead and say why.
      await deps.store.markFailed(claim, problem, deps.clock.now(), 0, MAX_SEND_ATTEMPTS, true);
      return { kind: "failed", retry: false };
    }
  } else if (text === "") {
    await deps.store.markFailed(claim, "The message rendered empty.", deps.clock.now(), 0, MAX_SEND_ATTEMPTS, true);
    return { kind: "failed", retry: false };
  }

  // Stored before the provider call: a crash right after it leaves a marker, so reconciliation looks instead of guessing.
  if (!(await deps.store.recordRendered(claim, { body: text }))) return { kind: "dropped" };

  try {
    if (claim.kind === "invitation") {
      const sent = await gateway.sendInvitation({ account: claim.account.providerAccountId, member: claim.providerId, note: text === "" ? null : text, sendKey: claim.sendId });
      if (isSubmitted(sent)) return await noteSendSubmitted(deps, claim, sent);
      await deps.store.markSent(claim, { providerMessageId: sent.invitationId, chatId: null }, deps.clock.now());
      return { kind: "sent", what: "invitation" };
    }
    const sent = await gateway.sendMessage({ account: claim.account.providerAccountId, to: { chat: claim.chatId, member: claim.providerId, slug: claim.slug }, text, sendKey: claim.sendId, unlessRepliedAfter: claim.outreachStartedAt });
    if (isSubmitted(sent)) return await noteSendSubmitted(deps, claim, sent);
    await deps.store.markSent(claim, { providerMessageId: sent.messageId, chatId: sent.chat }, deps.clock.now());
    return { kind: "sent", what: "message" };
  } catch (error) {
    return handleSendError(deps, claim, error);
  }
}

/** The send stays `sending`, so it counts against the limits and nobody reclaims it. A failure here reads as unknown, which reconciling looks into. */
async function noteSendSubmitted(deps: LinkedInEngineDeps, claim: LinkedInSendClaim, submitted: SubmittedOperation): Promise<LinkedInOutcome> {
  await deps.store.noteSubmitted({ kind: claim.kind, subjectId: claim.sendId, organizationId: claim.organizationId, account: claim.account, operation: submitted.operation, now: deps.clock.now() });
  return { kind: "submitted" };
}

/** Until when a limit stops the account: as long as the provider says, else the full pause. */
const pausedUntil = (error: LinkedInGatewayError, now: Date) => new Date(now.getTime() + (error.retryAfterMs ?? LIMIT_PAUSE_HOURS * 3_600_000));

export async function handleSendError(deps: LinkedInEngineDeps, claim: LinkedInSettleClaim, error: unknown): Promise<LinkedInOutcome> {
  const now = deps.clock.now();
  const message = errorText(error);
  if (error instanceof LinkedInGatewayError && error.kind === "definite") {
    switch (error.code) {
      case "rate_limited":
        if (error.limits === "recipient") {
          await deps.store.holdRecipient(claim, pausedUntil(error, now), message, now);
          return { kind: "blocked", reason: "recipient_held" };
        }
        if (error.limits === "invitations") await deps.store.pauseInvitationsForLimit(claim, pausedUntil(error, now));
        else await deps.store.pauseAccountForLimit(claim, pausedUntil(error, now));
        return { kind: "paused", reason: "limit" };
      case "replied":
        await deps.stopForReply(claim, now);
        return { kind: "blocked", reason: "replied" };
      case "auth":
        await deps.store.disconnectAccount(claim.account.id, message);
        await deps.store.release(claim);
        return { kind: "paused", reason: "disconnected" };
      case "already_connected":
        if (claim.kind === "invitation") {
          await deps.store.markAlreadyConnected(claim, now);
          return { kind: "sent", what: "invitation" };
        }
        break;
      case "already_invited":
        if (claim.kind === "invitation") {
          await deps.store.markSent(claim, { providerMessageId: null, chatId: null }, now);
          return { kind: "sent", what: "invitation" };
        }
        break;
      case "invalid_recipient":
      case "not_found":
      case "not_first_degree":
      // The account lacks access to this call. Trying again changes nothing, and the account itself is healthy.
      case "insufficient_privileges":
        await deps.store.markFailed(claim, message, now, 0, MAX_SEND_ATTEMPTS, true);
        return { kind: "failed", retry: false };
    }
    await deps.store.markFailed(claim, message, now, inviteRetryMinutes(claim.attempt), MAX_SEND_ATTEMPTS, false);
    return { kind: "failed", retry: claim.attempt < MAX_SEND_ATTEMPTS };
  }
  // Timeout, dropped connection, 5xx, or a non-gateway error: it may have gone out. Never retry on a guess.
  await deps.store.markUnknown(claim, message);
  return { kind: "unknown" };
}

export interface LinkedInReconcileReport {
  checked: number;
  foundSent: number;
  retryable: number;
  stillWaiting: number;
  expired: number;
}

/** Settles sends whose outcome is unknown from what LinkedIn reports, and ends invitations nobody accepted. */
export async function reconcileLinkedInSends(deps: LinkedInEngineDeps, limit = 25): Promise<LinkedInReconcileReport> {
  const now = deps.clock.now();
  const report: LinkedInReconcileReport = { checked: 0, foundSent: 0, retryable: 0, stillWaiting: 0, expired: 0 };
  const olderThan = new Date(now.getTime() - UNCERTAIN_AFTER_MINUTES * 60_000);

  const later = new Date(now.getTime() + UNCERTAIN_RECHECK_MINUTES * 60_000);
  for (const send of await deps.store.listUncertain(olderThan, limit, now)) {
    report.checked += 1;
    const retryIn = inviteRetryMinutes(send.attempt);
    if (!send.rendered) {
      // Crashed before the provider call: nothing can have been sent.
      await deps.store.resolveUncertainAsNotSent(send, now, retryIn, MAX_SEND_ATTEMPTS, "interrupted");
      report.retryable += 1;
      continue;
    }
    const gateway = await deps.gateways.forAccount({ organizationId: send.organizationId, accountId: send.account.id });
    if (!gateway) {
      await deps.store.deferUncertain(send.sendId, later);
      report.stillWaiting += 1;
      continue;
    }
    try {
      if (send.stepNumber === 1) {
        if (!send.providerId) throw new Error("no provider id");
        const status = await gateway.invitationStatus({ account: send.account.providerAccountId, member: send.providerId, since: send.claimedAt, sendKey: send.sendId });
        if (status !== "none") {
          await deps.store.resolveUncertainAsSent(send, { providerMessageId: null, accepted: status === "accepted" }, now);
          report.foundSent += 1;
          continue;
        }
      } else {
        const to = { chat: send.chatId, member: send.providerId, slug: send.slug };
        const found = send.body ? await gateway.findSentMessage({ account: send.account.providerAccountId, to, text: send.body, since: new Date(send.claimedAt.getTime() - 60_000), sendKey: send.sendId }) : null;
        if (found === "ask_a_person") {
          // Nothing here can say it did not go out, so waiting out the grace period would send it twice.
          await deps.store.markUnknown(send, "The message is not in the LinkedIn chat, and it may only be late. Check the chat and settle it.");
          await deps.store.deferUncertain(send.sendId, later);
          report.stillWaiting += 1;
          continue;
        }
        if (found) {
          await deps.store.resolveUncertainAsSent(send, { providerMessageId: found.messageId, accepted: false }, now);
          report.foundSent += 1;
          continue;
        }
      }
    } catch {
      // The provider cannot answer right now. Leave it unresolved, behind the sends it can answer for.
      await deps.store.deferUncertain(send.sendId, later);
      report.stillWaiting += 1;
      continue;
    }
    if (now.getTime() - send.claimedAt.getTime() >= NOT_FOUND_GRACE_MINUTES * 60_000) {
      await deps.store.resolveUncertainAsNotSent(send, now, retryIn, MAX_SEND_ATTEMPTS, "not_found");
      report.retryable += 1;
    } else {
      // Looks again when the grace period ends, the moment this answer can change.
      await deps.store.deferUncertain(send.sendId, new Date(send.claimedAt.getTime() + NOT_FOUND_GRACE_MINUTES * 60_000));
      report.stillWaiting += 1;
    }
  }

  report.expired = await deps.store.expireUnacceptedInvitations(new Date(now.getTime() - INVITE_EXPIRES_DAYS * 86_400_000), now);
  return report;
}

export type { LinkedInClaim };
