import type { WorkingHours } from "../../domain/working-hours";
import type { LinkedInInboundEvent } from "../domain/linkedin";
import type { Clock } from "../../application/clock";

/**
 * Why a gateway call failed. `kind` carries the outcome discipline of the email path:
 * definite: the provider answered with a refusal, nothing happened. Safe to retry or give up by rule.
 * unknown: timeout, dropped connection or a 5xx. The action may have happened. Never retried on a guess.
 */
export type GatewayErrorCode =
  | "auth"
  /** The account is healthy but outside the scope of this resource (for example a Sales Navigator lookup on a classic-only account). */
  | "insufficient_privileges"
  | "rate_limited"
  | "not_found"
  | "invalid_recipient"
  | "already_connected"
  | "already_invited"
  | "not_first_degree"
  | "rejected"
  | "unavailable";

export class LinkedInGatewayError extends Error {
  constructor(
    message: string,
    readonly kind: "definite" | "unknown",
    readonly code: GatewayErrorCode,
  ) {
    super(message);
  }
}

export interface GatewayAccount {
  /** The provider account id used for API calls. */
  ref: string;
  /** The LinkedIn member id of the account owner, when the provider reports it. */
  linkedinId: string | null;
  name: string | null;
  username: string | null;
  status: "connected" | "disconnected";
}

export type NetworkDistance = "first" | "second" | "third" | "out_of_network" | "unknown";

export interface GatewayProfile {
  /** Provider member id (what invitations and chats take). */
  member: string;
  publicSlug: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  location: string | null;
  pictureUrl: string | null;
  networkDistance: NetworkDistance;
  isPremium: boolean;
}

export interface SearchItem {
  /** Public slug or profile URL, whichever the provider gave. */
  identifier: string;
  profileUrl: string | null;
  name: string | null;
  headline: string | null;
  location: string | null;
  networkDistance: string | null;
  raw: unknown;
}

export interface SearchPage {
  items: SearchItem[];
  nextCursor: string | null;
  totalEstimate: number | null;
}

/** Port for LinkedIn. One instance serves one set of provider credentials. Unipile is the only adapter. */
export interface LinkedInGateway {
  /** Confirms the credentials work. Throws a LinkedInGatewayError a person can act on. */
  verify(): Promise<void>;
  listAccounts(): Promise<GatewayAccount[]>;
  /** Own profile of a connected account (premium flag, name). */
  getOwnProfile(account: string): Promise<GatewayProfile>;
  /** Resolves a slug or a member id to a provider member id. `linkedinApi` is set only on the retry for a Sales Navigator or Recruiter member id, after a classic lookup found nothing. */
  getProfile(input: { account: string; identifier: string; linkedinApi?: "sales_navigator" | "recruiter" }): Promise<GatewayProfile>;
  sendInvitation(input: { account: string; member: string; note: string | null }): Promise<{ invitationId: string | null }>;
  /**
   * For reconciling an unknown invitation: still pending, accepted (the member is now first degree), or not found.
   * Throws when the provider cannot answer.
   */
  invitationStatus(input: { account: string; member: string }): Promise<"pending" | "accepted" | "none">;
  findChat(input: { account: string; member: string }): Promise<string | null>;
  sendMessage(input: { account: string; chat: string; text: string }): Promise<{ messageId: string | null }>;
  startChat(input: { account: string; member: string; text: string }): Promise<{ chat: string | null; messageId: string | null }>;
  /** For reconciling an unknown message: a message from the account owner with this text after `since`. */
  findSentMessage(input: { account: string; chat: string; text: string; since: Date }): Promise<{ messageId: string | null } | null>;
  searchPeople(input: { account: string; searchUrl: string; cursor: string | null }): Promise<SearchPage>;
  /** Registers webhooks that call `requestUrl` with `secret` in the `x-unipile-secret` header. Idempotent. */
  registerWebhooks(input: { requestUrl: string; secret: string; name: string }): Promise<WebhookRegistration>;
  /** Deletes every webhook whose `request_url` equals `requestUrl` (all list pages). Returns how many it deleted. */
  removeWebhooks(input: { requestUrl: string }): Promise<{ removed: number }>;
  /**
   * Makes a single-use hosted-auth link. `reconnectAccount` re-authenticates that provider account in place; without it the link connects a new LinkedIn account.
   * The caller sends the person to `url` in a full page navigation (Unipile advises against an iframe).
   */
  createHostedAuthLink(input: HostedAuthLinkInput): Promise<{ url: string }>;
}

/** One entry per hook the gateway tried to create. `error` holds the gateway failure, which the caller turns into fixed text. */
export interface WebhookRegistration {
  /** Names of the hooks that were created. */
  registered: string[];
  hooks: Array<{ name: string; error: unknown | null }>;
}

export interface HostedAuthLinkInput {
  /** Echoed back as `name` on the notify callback. */
  name: string;
  expiresAt: Date;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  /** Left out when Unipile cannot reach this app (a local address). */
  notifyUrl: string | null;
  reconnectAccount: string | null;
}

/** Hands out the gateway for an organization, or null when that organization has not connected LinkedIn. */
export interface LinkedInGatewayProvider {
  forOrganization(organizationId: string): Promise<LinkedInGateway | null>;
}

/** What the engine knows about a claimed unit of work. */
export interface LinkedInSendClaim {
  kind: "invitation" | "message";
  sendId: string;
  organizationId: string;
  attempt: number;
  stepNumber: number;
  enrollmentId: string;
  campaignId: string;
  account: { id: string; providerAccountId: string };
  person: { id: string; variables: Record<string, string | null> };
  providerId: string;
  /** Known chat with this member, if any. */
  chatId: string | null;
  step: { body: string; waitDays: number };
  /** The step after this one, if any, for scheduling. */
  nextStep: { waitDays: number } | null;
}

export interface LinkedInResolveClaim {
  kind: "resolve";
  organizationId: string;
  enrollmentId: string;
  account: { id: string; providerAccountId: string };
  /** Slug on the person, else the enrollment's profile URL: a profile URL, a Sales Navigator or Recruiter URL, or a bare member id. */
  identifier: string;
  failures: number;
}

export type LinkedInClaim = LinkedInSendClaim | LinkedInResolveClaim;

/** `enrollment_stopped`: the enrollment is no longer pending or active (replied, suppressed, removed). */
export type LinkedInBlockReason = "campaign_inactive" | "do_not_contact" | "enrollment_stopped";

export interface LinkedInClaimOptions {
  accountId: string;
  now: Date;
  random: () => number;
  defaultWorkingHours: (organizationTimeZone: string | null) => WorkingHours;
}

export interface ResolvedProfile {
  providerId: string;
  slug: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  pictureUrl: string | null;
  /** Member id the lookup started from (Sales Navigator, Recruiter or bare provider id). Absent for a slug lookup. */
  memberId?: string;
}

/** `slug_collision`: the resolved slug already belongs to another lead of the organization, so the enrollment failed. */
export type ResolveWriteResult = "resolved" | "slug_collision";

export interface UncertainLinkedInSend {
  sendId: string;
  organizationId: string;
  enrollmentId: string;
  stepNumber: number;
  attempt: number;
  claimedAt: Date;
  /** Set once the engine rendered the content, which happens right before the provider call. Null means nothing can have gone out. */
  rendered: boolean;
  body: string | null;
  chatId: string | null;
  account: { id: string; providerAccountId: string };
  providerId: string | null;
  nextStepWaitDays: number | null;
}

/** Port for LinkedIn outreach persistence. Each method is one atomic step. */
export interface LinkedInOutreachStore {
  /** Connected accounts whose gap has passed, oldest first. */
  listActionableAccounts(now: Date): Promise<Array<{ id: string; organizationId: string }>>;
  /**
   * One transaction: lock the account, check status, limit pause, gap and hours, then pick work
   * (a due message, an invitation within the daily and weekly limits, or a profile to resolve)
   * and place the gap. A message or invitation is a `sends` row, so it cannot be claimed twice.
   */
  claimNext(options: LinkedInClaimOptions): Promise<LinkedInClaim | null>;
  checkBlockers(claim: LinkedInSendClaim): Promise<LinkedInBlockReason | null>;
  abandon(claim: LinkedInSendClaim, reason: LinkedInBlockReason, now: Date): Promise<void>;
  /** Stores the rendered content and the marker that the provider call may start. */
  recordRendered(claim: LinkedInSendClaim, rendered: { body: string }): Promise<void>;
  markSent(claim: LinkedInSendClaim, sent: { providerMessageId: string | null; chatId: string | null }, now: Date): Promise<void>;
  /** Definite refusal. `fatal` skips the retries. */
  markFailed(claim: LinkedInSendClaim, error: string, now: Date, retryAfterMinutes: number, maxAttempts: number, fatal: boolean): Promise<void>;
  markUnknown(claim: LinkedInSendClaim, error: string): Promise<void>;
  /** Gives the claim back without using an attempt (nothing reached the provider, or the account must stop). */
  release(claim: LinkedInSendClaim): Promise<void>;
  /** The provider says we are already connected: skip the invitation and go on with the messages. */
  markAlreadyConnected(claim: LinkedInSendClaim, now: Date): Promise<void>;
  /** LinkedIn refused for a limit: give the attempt back and stop the account for a while. */
  pauseAccountForLimit(claim: LinkedInSendClaim, until: Date): Promise<void>;
  /** The provider rejected the credentials or the account: give the attempt back and mark the account disconnected. */
  disconnectAccount(accountId: string, error: string): Promise<void>;

  markResolved(claim: LinkedInResolveClaim, profile: ResolvedProfile, now: Date): Promise<ResolveWriteResult>;
  markResolveFailed(claim: LinkedInResolveClaim, error: string, now: Date, fatal: boolean): Promise<void>;

  listUncertain(olderThan: Date, limit: number): Promise<UncertainLinkedInSend[]>;
  resolveUncertainAsSent(send: UncertainLinkedInSend, sent: { providerMessageId: string | null; accepted: boolean }, now: Date): Promise<void>;
  resolveUncertainAsNotSent(send: UncertainLinkedInSend, now: Date, retryAfterMinutes: number, maxAttempts: number): Promise<void>;
  /** Invitations nobody accepted after the expiry: end the sequence. Returns how many. */
  expireUnacceptedInvitations(before: Date, now: Date): Promise<number>;
}

export interface LinkedInEngineDeps {
  store: LinkedInOutreachStore;
  gateways: LinkedInGatewayProvider;
  clock: Clock;
  random: () => number;
}

/** A ledger row as the inbound pipeline sees it. */
export interface LedgerEvent {
  id: string;
  organizationId: string | null;
  payload: unknown;
  attempts: number;
  /** Written by the claim (`begin`, `claimReplayable`). `finish` and `fail` change the row only while it still carries it. */
  claimToken: string;
}

export type InboundResult = "done" | "skipped";

/** Persistence for webhook deliveries and the state changes they cause. */
export interface LinkedInInboundStore {
  /** Inserts the delivery as `processing`. Returns null when the key was seen before. */
  begin(input: { organizationId: string; key: string; eventType: string; accountRef: string; payload: unknown; now: Date }): Promise<LedgerEvent | null>;
  /** Settles the claim. A worker whose lease ran out, or whose row an admin requeued and another claim took, changes nothing. */
  finish(claim: LedgerEvent, status: "done" | "skipped", note: string | null, now: Date): Promise<void>;
  fail(claim: LedgerEvent, error: string, now: Date, retryAt: Date | null): Promise<void>;
  /**
   * Failed rows due for retry, and `processing` rows whose lease expired. Claims them (attempt + 1, lease, fresh token)
   * atomically. A `processing` row whose lease expired on its last attempt turns `failed` first, where an admin can replay it.
   */
  claimReplayable(now: Date, limit: number, leaseSeconds: number, organizationId?: string): Promise<LedgerEvent[]>;
  /** Applies one event. Safe to run twice for the same event. */
  apply(organizationId: string, event: LinkedInInboundEvent, now: Date): Promise<{ result: InboundResult; note: string | null }>;
}

export interface LinkedInInboundDeps {
  store: LinkedInInboundStore;
  clock: Clock;
  /** Turns a raw provider payload into a normalized event, or null for payloads this app ignores. */
  parse: (payload: unknown) => LinkedInInboundEvent | null;
}
