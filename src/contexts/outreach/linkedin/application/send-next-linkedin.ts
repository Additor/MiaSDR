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
import { MAX_SEND_ATTEMPTS, NOT_FOUND_GRACE_MINUTES, UNCERTAIN_AFTER_MINUTES } from "../../domain/send-policy";
import { defaultWorkingHours } from "../../domain/working-hours";
import {
  LinkedInGatewayError,
  type GatewayProfile,
  type LinkedInClaim,
  type LinkedInEngineDeps,
  type LinkedInGateway,
  type LinkedInResolveClaim,
  type LinkedInSendClaim,
} from "./linkedin-ports";

export type LinkedInOutcome =
  | { kind: "idle" }
  | { kind: "sent"; what: "invitation" | "message" }
  | { kind: "resolved" }
  | { kind: "resolve_failed" }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; retry: boolean }
  | { kind: "paused"; reason: "limit" | "disconnected" | "no_gateway" }
  | { kind: "unknown" };

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

  const gateway = await deps.gateways.forOrganization(claim.organizationId);
  if (claim.kind === "resolve") {
    if (!gateway) return { kind: "paused", reason: "no_gateway" };
    return resolve(deps, gateway, claim);
  }
  if (!gateway) {
    // LinkedIn was disconnected between the claim and the call. Nothing went out: give the attempt back.
    await deps.store.disconnectAccount(claim.account.id, "LinkedIn is not connected for this organization.");
    await deps.store.release(claim);
    return { kind: "paused", reason: "no_gateway" };
  }
  return deliver(deps, gateway, claim);
}

const NO_PREMIUM_ACCESS = "This LinkedIn account has no Sales Navigator or Recruiter access, and the member could not be found with a standard lookup.";
const UNREADABLE_PROFILE = "This LinkedIn URL does not identify a person profile.";

/** What the lookup sends: a slug or URL goes through as stored (classic), a member id goes with its API.
 * `linkedinApi` is not sent on the first call. It marks the Sales Navigator or Recruiter fallback that `lookupProfile` may try next. */
function lookupInput(identifier: string): { identifier: string; linkedinApi?: "sales_navigator" | "recruiter"; memberId?: string } | null {
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

type LookupResult = { ok: true; profile: GatewayProfile } | { ok: false; reason: "no_access" };

/**
 * Looks a member up. The first call carries no linkedin_api. For a Sales Navigator or Recruiter reference, a definite
 * answer other than auth or rate_limited (see FALLBACK_AFTER) earns one retry with linkedin_api. An out-of-scope answer to
 * that retry means the account has no such product: `no_access`. Everything else throws: auth, rate_limited and unknown
 * outcomes on either call, and any other definite failure of the retry.
 */
async function lookupProfile(gateway: LinkedInGateway, account: string, lookup: { identifier: string; linkedinApi?: "sales_navigator" | "recruiter" }): Promise<LookupResult> {
  try {
    return { ok: true, profile: await gateway.getProfile({ account, identifier: lookup.identifier }) };
  } catch (first) {
    if (!lookup.linkedinApi || !(first instanceof LinkedInGatewayError) || first.kind !== "definite" || !FALLBACK_AFTER.has(first.code)) throw first;
  }
  try {
    return { ok: true, profile: await gateway.getProfile({ account, identifier: lookup.identifier, linkedinApi: lookup.linkedinApi }) };
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
    const found = await lookupProfile(gateway, claim.account.providerAccountId, lookup);
    if (!found.ok) {
      // The account is healthy. It lacks the product, so the lead may resolve later (the plan can change) and retries with backoff.
      await deps.store.markResolveFailed(claim, NO_PREMIUM_ACCESS, deps.clock.now(), false);
      return { kind: "resolve_failed" };
    }
    const profile = found.profile;
    const written = await deps.store.markResolved(
      claim,
      {
        providerId: profile.member,
        slug: profile.publicSlug,
        firstName: profile.firstName,
        lastName: profile.lastName,
        headline: profile.headline,
        pictureUrl: profile.pictureUrl,
        ...(lookup.memberId ? { memberId: lookup.memberId } : {}),
      },
      deps.clock.now(),
    );
    return written === "slug_collision" ? { kind: "resolve_failed" } : { kind: "resolved" };
  } catch (error) {
    const code = error instanceof LinkedInGatewayError ? error.code : null;
    if (code === "auth") {
      await deps.store.disconnectAccount(claim.account.id, errorText(error));
      return { kind: "paused", reason: "disconnected" };
    }
    // A lookup changes nothing at the provider, so every failure is safe to retry later.
    await deps.store.markResolveFailed(claim, errorText(error), deps.clock.now(), code === "not_found" || code === "invalid_recipient");
    return { kind: "resolve_failed" };
  }
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
  await deps.store.recordRendered(claim, { body: text });

  try {
    if (claim.kind === "invitation") {
      const sent = await gateway.sendInvitation({ account: claim.account.providerAccountId, member: claim.providerId, note: text === "" ? null : text });
      await deps.store.markSent(claim, { providerMessageId: sent.invitationId, chatId: null }, deps.clock.now());
      return { kind: "sent", what: "invitation" };
    }
    const sent = await sendMessage(gateway, claim, text);
    await deps.store.markSent(claim, sent, deps.clock.now());
    return { kind: "sent", what: "message" };
  } catch (error) {
    return handleSendError(deps, claim, error);
  }
}

async function sendMessage(gateway: LinkedInGateway, claim: LinkedInSendClaim, text: string) {
  const account = claim.account.providerAccountId;
  // Looking up the chat sends nothing, so a failure here is a definite miss. It throws before any send.
  const chat = claim.chatId ?? (await gateway.findChat({ account, member: claim.providerId }));
  if (chat) {
    const sent = await gateway.sendMessage({ account, chat, text });
    return { providerMessageId: sent.messageId, chatId: chat };
  }
  const started = await gateway.startChat({ account, member: claim.providerId, text });
  return { providerMessageId: started.messageId, chatId: started.chat };
}

async function handleSendError(deps: LinkedInEngineDeps, claim: LinkedInSendClaim, error: unknown): Promise<LinkedInOutcome> {
  const now = deps.clock.now();
  const message = errorText(error);
  if (error instanceof LinkedInGatewayError && error.kind === "definite") {
    switch (error.code) {
      case "rate_limited":
        await deps.store.pauseAccountForLimit(claim, new Date(now.getTime() + LIMIT_PAUSE_HOURS * 3_600_000));
        return { kind: "paused", reason: "limit" };
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

  for (const send of await deps.store.listUncertain(olderThan, limit)) {
    report.checked += 1;
    const retryIn = inviteRetryMinutes(send.attempt);
    if (!send.rendered) {
      // Crashed before the provider call: nothing can have been sent.
      await deps.store.resolveUncertainAsNotSent(send, now, retryIn, MAX_SEND_ATTEMPTS);
      report.retryable += 1;
      continue;
    }
    const gateway = await deps.gateways.forOrganization(send.organizationId);
    if (!gateway) {
      report.stillWaiting += 1;
      continue;
    }
    try {
      if (send.stepNumber === 1) {
        if (!send.providerId) throw new Error("no provider id");
        const status = await gateway.invitationStatus({ account: send.account.providerAccountId, member: send.providerId });
        if (status !== "none") {
          await deps.store.resolveUncertainAsSent(send, { providerMessageId: null, accepted: status === "accepted" }, now);
          report.foundSent += 1;
          continue;
        }
      } else {
        const chat = send.chatId ?? (send.providerId ? await gateway.findChat({ account: send.account.providerAccountId, member: send.providerId }) : null);
        const found = chat && send.body ? await gateway.findSentMessage({ account: send.account.providerAccountId, chat, text: send.body, since: new Date(send.claimedAt.getTime() - 60_000) }) : null;
        if (found) {
          await deps.store.resolveUncertainAsSent(send, { providerMessageId: found.messageId, accepted: false }, now);
          report.foundSent += 1;
          continue;
        }
      }
    } catch {
      // The provider cannot answer right now. Leave it unresolved.
      report.stillWaiting += 1;
      continue;
    }
    if (now.getTime() - send.claimedAt.getTime() >= NOT_FOUND_GRACE_MINUTES * 60_000) {
      await deps.store.resolveUncertainAsNotSent(send, now, retryIn, MAX_SEND_ATTEMPTS);
      report.retryable += 1;
    } else {
      report.stillWaiting += 1;
    }
  }

  report.expired = await deps.store.expireUnacceptedInvitations(new Date(now.getTime() - INVITE_EXPIRES_DAYS * 86_400_000), now);
  return report;
}

export type { LinkedInClaim };
