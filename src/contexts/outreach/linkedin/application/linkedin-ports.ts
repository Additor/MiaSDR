import type { NotSentCause } from "../../domain/send-policy";
import type { WorkingHours } from "../../domain/working-hours";
import type { LinkedInInboundEvent } from "../domain/linkedin";
import type { OpenOperationKind } from "../domain/linkedin-operations";
import type { Clock } from "../../application/clock";
import type { SearchPageClaim } from "./linkedin-search-ports";

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
  /** The person wrote after the moment `unlessRepliedAfter` named, so nothing went out. */
  | "replied"
  | "rejected"
  | "unavailable";

export class LinkedInGatewayError extends Error {
  constructor(
    message: string,
    readonly kind: "definite" | "unknown",
    readonly code: GatewayErrorCode,
    /** For `rate_limited`: how long the limit lasts, when the provider says. Without it the account stops for the full pause. */
    readonly retryAfterMs: number | null = null,
    /**
     * For `rate_limited`: what the limit stops. `invitations` also covers profile lookups, which only lead to invitations, and
     * a search that hits it waits alone. `recipient`: the refusal is about this person's thread, so the next lead can still go.
     */
    readonly limits: "account" | "invitations" | "recipient" = "account",
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
  /** Null: this vendor does not say, so a sync leaves the account's setting as it is. */
  isPremium: boolean | null;
  /** The LinkedIn member URN, for a vendor whose acceptance events name people by it. */
  memberUrn?: string | null;
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

/** A vendor took the action and will run it later. It settles through `LinkedInGateway.operations`. */
export interface SubmittedOperation {
  operation: string;
}

export const isSubmitted = (answer: object): answer is SubmittedOperation => "operation" in answer;

export type SentInvitation = { invitationId: string | null };
export type SentMessage = { chat: string | null; messageId: string | null };

/** A lookup that found the person only by a public slug: a classic lookup of that slug names them. */
export type LookAgain = { lookAgain: string };

/** What each kind of action answers once it finished. */
export interface OperationValues {
  invitation: SentInvitation;
  message: SentMessage;
  lookup: GatewayProfile | LookAgain;
  search: SearchPage;
  reply_check: null;
}

export type OperationProgress<K extends OpenOperationKind> =
  /** `held`: the vendor is holding it for its working hours, so nothing has started. */
  | { state: "waiting"; held: boolean }
  | { state: "finished"; value: OperationValues[K] }
  /** The vendor says the action failed. `error.kind` says whether a write may have gone out. */
  | { state: "failed"; error: LinkedInGatewayError };

/**
 * For a vendor that runs actions after it answered.
 * A throw from any of these means the read failed. It never means the action was refused: a refusal read that way would send twice.
 */
export interface LinkedInGatewayOperations {
  progress<K extends OpenOperationKind>(input: { account: string; operation: string; kind: K }): Promise<OperationProgress<K>>;
  /** `already_finished`: too late to stop, so `progress` has the outcome. Only `cancelled` means it will not run. */
  cancel(input: { account: string; operation: string }): Promise<"cancelled" | "already_finished">;
  /** The most people one search action reads on this URL. */
  maxSearchRead(searchUrl: string): number;
  /** Asks the vendor to read a thread into what it can answer about. */
  checkThread(input: { account: string; to: LinkedInRecipient; since: Date }): Promise<SubmittedOperation>;
  /** Raw deliveries for the same ledger an inbox read goes through: what the person wrote in the thread since `since`. */
  readThread(input: { account: string; to: LinkedInRecipient; since: Date }): Promise<unknown[]>;
}

/** Port for LinkedIn. One instance serves one set of provider credentials. Adapters live in `infrastructure/vendors`. */
export interface LinkedInGateway {
  /** Confirms the credentials work. Throws a LinkedInGatewayError a person can act on. */
  verify(): Promise<void>;
  /** The accounts the credentials reach. `only`: these refs alone, for a vendor whose listing is not this organization's alone. */
  listAccounts(only?: string[]): Promise<GatewayAccount[]>;
  /** Own profile of a connected account (premium flag, name). */
  getOwnProfile(account: string): Promise<GatewayProfile>;
  /** Absent on a vendor that answers each call with its outcome. Where it is present, a call below may answer `SubmittedOperation`. */
  operations?: LinkedInGatewayOperations;
  /** Resolves a slug or a member id to a provider member id. `linkedinApi` is set only on the retry for a Sales Navigator or Recruiter member id, after a classic lookup found nothing. */
  getProfile(input: { account: string; identifier: string; linkedinApi?: "sales_navigator" | "recruiter" }): Promise<GatewayProfile | SubmittedOperation>;
  /** `sendKey` names this send across its retries, for a vendor that answers a repeat instead of sending again. Others ignore it. */
  sendInvitation(input: { account: string; member: string; note: string | null; sendKey: string }): Promise<SentInvitation | SubmittedOperation>;
  /**
   * For reconciling an unknown invitation: still pending, accepted (the member is now first degree), or not found.
   * Throws when the provider cannot answer.
   */
  invitationStatus(input: { account: string; member: string; since: Date; sendKey: string }): Promise<"pending" | "accepted" | "none">;
  /**
   * Sends to whoever `to` names. Answers the chat it went into, when the provider says. Throws a definite `invalid_recipient` when `to` is not enough for this provider.
   * `unlessRepliedAfter`: best effort. A vendor that can read the thread first throws a definite `replied` when the person wrote after this moment. Others ignore it.
   */
  sendMessage(input: { account: string; to: LinkedInRecipient; text: string; sendKey: string; unlessRepliedAfter: Date | null }): Promise<SentMessage | SubmittedOperation>;
  /**
   * For reconciling an unknown message: a message from the account owner with this text after `since`. Null leads to a
   * resend, so it means the provider showed there is none. Throws when it cannot tell. `ask_a_person`: not found, and this vendor
   * cannot rule it out however long it waits, so nothing resends it and a person settles it.
   */
  findSentMessage(input: { account: string; to: LinkedInRecipient; text: string; since: Date; sendKey: string }): Promise<{ messageId: string | null } | "ask_a_person" | null>;
  /** `limit`: the most people this call may read, for a vendor that reads a whole search in one action. Others read one page. */
  searchPeople(input: { account: string; searchUrl: string; cursor: string | null; limit: number }): Promise<SearchPage | SubmittedOperation>;
  /**
   * Makes a single-use link that connects a LinkedIn account. `reconnectAccount` re-authenticates that provider account in place; without it the link connects a new one.
   * The caller sends the person to `url` in a full page navigation. `account`: the provider account the link is for, when it exists already.
   * Absent for a vendor whose accounts connect only in its own app.
   */
  createConnectLink?(input: ConnectLinkInput): Promise<{ url: string; account?: string | null }>;
}

/** Whom a message goes to, with all that is known. A provider uses what it can address by. */
export interface LinkedInRecipient {
  chat: string | null;
  /** The provider member id (ACoAA...). */
  member: string | null;
  /** The public profile slug. */
  slug: string | null;
}

/** For a vendor whose webhooks are managed through its API. */
export interface LinkedInWebhookAdmin {
  /** Registers webhooks that call `requestUrl` and carry `secret`, in the header `LinkedInVendor.webhooks` names. Idempotent. */
  registerWebhooks(input: { requestUrl: string; secret: string; name: string }): Promise<WebhookRegistration>;
  /** Deletes every webhook whose `request_url` equals `requestUrl` (all list pages). Returns how many it deleted. */
  removeWebhooks(input: { requestUrl: string }): Promise<{ removed: number }>;
}

/** One entry per hook the gateway tried to create. `error` holds the gateway failure, which the caller turns into fixed text. */
export interface WebhookRegistration {
  /** Names of the hooks that were created. */
  registered: string[];
  hooks: Array<{ name: string; error: unknown | null }>;
}

export interface ConnectLinkInput {
  /** Echoed back as `name` on the notify callback. */
  name: string;
  expiresAt: Date;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  /** Left out when the vendor cannot reach this app (a local address). */
  notifyUrl: string | null;
  reconnectAccount: string | null;
  /** The organization's zone, for a vendor that picks a new account's sign-in address by it. Null when it has none. */
  timeZone: string | null;
}

/** Fields a vendor needs to reach its API, stored encrypted as given. The application passes them through without reading them. */
export type VendorCredentials = Record<string, string>;

/** What the connection flows need to know about the company behind a gateway: its credentials, sentences, webhooks and callback. */
export interface LinkedInVendor {
  /** The stable value stored and logged for this vendor. */
  readonly key: string;
  /** How people know this vendor, for sentences. */
  readonly name: string;
  /** The connection's name on the integrations page. */
  readonly integrationName: string;
  /** Whether an account the listing shows becomes an account here. False: only one connected through this app does. */
  readonly syncAddsAccounts: boolean;
  /** How long a connect link stays valid. Null: accounts connect in the vendor's own app, and a sync brings them here. */
  readonly connectLinkMinutes: number | null;
  /** Checks what a person entered and returns the credentials to store. Throws a ValidationError a person can act on. */
  readConnectInput(input: Record<string, string>): VendorCredentials;
  /** Builds the gateway for credentials. Throws a ConflictError a person can act on when they may no longer be used. */
  gatewayFor(credentials: VendorCredentials): LinkedInGateway;
  /** The address an owner or admin sees after "Connected to", or null when the vendor's name says enough. */
  connectedTo(credentials: VendorCredentials | null): string | null;
  /** Fixed text for a gateway failure. The upstream text never reaches a person. */
  explain(error: unknown): string;
  /** The same, for a sync that used stored credentials. */
  explainSyncFailure(error: unknown): string;
  /** For a vendor with no webhooks here: how replies and acceptances arrive, in a sentence for a person. */
  readonly inboundNote?: string;
  /** Null: this vendor sends nothing this app acts on by webhook. */
  readonly webhooks: {
    requestUrl(appUrl: string, organizationId: string): string;
    /** The header that carries the organization's secret. */
    headerName: string;
    hooks: ReadonlyArray<{ name: string; source: string; event: string }>;
    admin(credentials: VendorCredentials): LinkedInWebhookAdmin;
  } | null;
  /** How a connect link reports back by itself. Null: the app asks `connectSession` instead. */
  readonly connectCallback: {
    urls(input: { appUrl: string; linkId: string; secret: string }): { success: string; failure: string; notify: string };
    /** Reads the vendor's connect callback. Null for a body it cannot read. */
    readNotify(payload: unknown): { status: string; connected: boolean; accountId: string | null; name: string } | null;
  } | null;
  /** For a vendor whose link does not report back. */
  readonly connectSession: {
    /**
     * How the link stands. `link.ref` is what `createConnectLink` named. `account`: the account that signed in, when it is not
     * `link.ref`. `error`: a sentence for a failed link, when the vendor said why.
     */
    status(credentials: VendorCredentials, link: { ref: string; createdAt: Date; reconnectAccount: string | null }): Promise<{ state: "pending" | "connected" | "failed"; account?: string; error?: string }>;
    /** Removes what `createConnectLink` named at the vendor. The caller checks that no row here uses it. */
    cancel(credentials: VendorCredentials, ref: string): Promise<void>;
    /** True: two open links could not be told apart, so only one may be open. */
    oneLinkAtATime?: boolean;
  } | null;
}

/** Hands out the gateway for one LinkedIn account, or null when its vendor is not connected for that organization. */
export interface LinkedInGatewayProvider {
  forAccount(input: { organizationId: string; accountId: string }): Promise<LinkedInGateway | null>;
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
  /** The lead's public profile slug, if known. */
  slug: string | null;
  step: { body: string; waitDays: number };
  /** The step after this one, if any, for scheduling. */
  nextStep: { waitDays: number } | null;
  /** When this enrollment's outreach began: its first send, else the acceptance. A message after that from this person is a reply. */
  outreachStartedAt: Date | null;
}

export interface LinkedInResolveClaim {
  kind: "resolve";
  organizationId: string;
  enrollmentId: string;
  account: { id: string; providerAccountId: string };
  /** Slug on the person, else the enrollment's profile URL: a profile URL, a Sales Navigator or Recruiter URL, or a bare member id. */
  identifier: string;
  failures: number;
  /** The product a vendor's earlier lookup moved this one on to. Null: start with the classic lookup. */
  nextApi: "sales_navigator" | "recruiter" | null;
}

/** Before a campaign message on an account that came back from a reconnect: replies written while it was gone were never read. */
export interface LinkedInReplyCheckClaim {
  kind: "reply_check";
  organizationId: string;
  enrollmentId: string;
  account: { id: string; providerAccountId: string };
  to: LinkedInRecipient;
  since: Date;
}

export type LinkedInClaim = LinkedInSendClaim | LinkedInResolveClaim | LinkedInReplyCheckClaim;

/** What settling a send needs, when the step it was claimed for may be gone. Every engine write takes this much. */
export type LinkedInSettleClaim = Pick<LinkedInSendClaim, "kind" | "sendId" | "organizationId" | "attempt" | "stepNumber" | "enrollmentId" | "campaignId" | "providerId" | "nextStep"> & {
  account: { id: string };
  person: { id: string };
};

/** `enrollment_stopped`: the enrollment is no longer pending or active (replied, suppressed, removed). */
export type LinkedInBlockReason = "campaign_inactive" | "suppressed" | "do_not_contact" | "enrollment_stopped";

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
  memberUrn?: string | null;
}

/**
 * `slug_collision`: the resolved slug already belongs to another lead of the organization, so the enrollment failed.
 * `stopped`: the lead stopped while the lookup ran, so nothing was written and it stays unpinned.
 */
export type ResolveWriteResult = "resolved" | "slug_collision" | "stopped";

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
  slug: string | null;
  account: { id: string; providerAccountId: string };
  providerId: string | null;
  nextStepWaitDays: number | null;
}

/** What settling a send whose outcome was unknown needs. A person settling one by hand knows no more than this. */
export type SettledLinkedInSend = Pick<UncertainLinkedInSend, "sendId" | "enrollmentId" | "stepNumber" | "attempt" | "nextStepWaitDays"> & { account: { id: string } };

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
  checkBlockers(claim: LinkedInSettleClaim): Promise<LinkedInBlockReason | null>;
  abandon(claim: LinkedInSettleClaim, reason: LinkedInBlockReason, now: Date): Promise<void>;
  /** Stores the rendered content and the marker that the provider call may start. False: this claim no longer owns the send, so no call may start. */
  recordRendered(claim: LinkedInSendClaim, rendered: { body: string }): Promise<boolean>;
  markSent(claim: LinkedInSettleClaim, sent: { providerMessageId: string | null; chatId: string | null }, now: Date): Promise<void>;
  /** Definite refusal. `fatal` skips the retries. */
  markFailed(claim: LinkedInSettleClaim, error: string, now: Date, retryAfterMinutes: number, maxAttempts: number, fatal: boolean): Promise<void>;
  markUnknown(claim: { sendId: string; attempt: number }, error: string): Promise<void>;
  /** Gives the claim back without using an attempt (nothing reached the provider, or the account must stop). */
  release(claim: LinkedInSettleClaim): Promise<void>;
  /** The provider says we are already connected: skip the invitation and go on with the messages. */
  markAlreadyConnected(claim: LinkedInSettleClaim, now: Date): Promise<void>;
  /** LinkedIn refused for a limit: give the attempt back and stop the account for a while. */
  pauseAccountForLimit(claim: LinkedInSettleClaim, until: Date): Promise<void>;
  /** LinkedIn refused an invitation for a limit that stops invitations alone: give the attempt back and hold invitations and lookups for a while. */
  pauseInvitationsForLimit(claim: LinkedInSettleClaim, until: Date): Promise<void>;
  /** LinkedIn refused a profile lookup for a limit that stops invitations alone. The lead keeps its retries. */
  pauseInvitationsForLookupLimit(claim: LinkedInResolveClaim, until: Date): Promise<void>;
  /** The vendor refused a send for a reason about this person's thread: give the attempt back and try this lead again at `until`. The account goes on. */
  holdRecipient(claim: LinkedInSettleClaim, until: Date, error: string, now: Date): Promise<void>;
  /** The provider rejected the credentials or the account: give the attempt back and mark the account disconnected. */
  disconnectAccount(accountId: string, error: string): Promise<void>;

  /** LinkedIn refused a profile lookup for a limit: stop the account for a while. The lead keeps its retries. */
  pauseAccountForLookupLimit(claim: { account: { id: string } }, until: Date): Promise<void>;
  markResolved(claim: LinkedInResolveClaim, profile: ResolvedProfile, now: Date): Promise<ResolveWriteResult>;
  markResolveFailed(claim: LinkedInResolveClaim, error: string, now: Date, fatal: boolean): Promise<void>;

  /** The vendor took the action and will run it later. The row exists before the claim's work can be settled, and closes the account's gate. */
  noteSubmitted(input: { kind: OpenOperationKind; subjectId: string; organizationId: string; account: { id: string; providerAccountId: string }; operation: string; api?: string | null; rowLimit?: number | null; now: Date }): Promise<void>;
  /** After a classic lookup found nobody: the next lookup uses this product. */
  moveResolveToApi(claim: LinkedInResolveClaim, api: "sales_navigator" | "recruiter", now: Date): Promise<void>;
  /** A lookup named only a public slug. The person takes it, so the next lookup is a classic one. A slug another lead holds fails the enrollment. */
  resolveBySlug(claim: LinkedInResolveClaim, slug: string, now: Date): Promise<void>;
  /** The lead's thread was read at `now`: nothing older than this stops it from here. */
  markReplyChecked(enrollmentId: string, now: Date): Promise<void>;
  /** A look at the lead's thread could not finish. It waits, and the account's other leads go first. */
  deferReplyCheck(enrollmentId: string, until: Date): Promise<void>;

  deferUncertain(sendId: string, until: Date): Promise<void>;
  listUncertain(olderThan: Date, limit: number, now: Date): Promise<UncertainLinkedInSend[]>;
  resolveUncertainAsSent(send: SettledLinkedInSend, sent: { providerMessageId: string | null; accepted: boolean }, now: Date): Promise<void>;
  resolveUncertainAsNotSent(send: SettledLinkedInSend, now: Date, retryAfterMinutes: number, maxAttempts: number, cause: NotSentCause): Promise<void>;
  /** Invitations nobody accepted after the expiry: end the sequence. Returns how many. */
  expireUnacceptedInvitations(before: Date, now: Date): Promise<number>;
}

/** One action a vendor has not finished, with what settling it needs. `subject` is null when its send, lead or search was purged. */
export type OpenLinkedInOperation = {
  id: string;
  organizationId: string;
  accountId: string;
  /** The vendor's stored key, for the ledger. */
  provider: string;
  /** The account id it was submitted as. */
  providerAccountRef: string;
  operation: string;
  submittedAt: Date;
} & (
  | { kind: "invitation" | "message"; subject: LinkedInSettleClaim | null }
  | { kind: "lookup"; api: "sales_navigator" | "recruiter" | null; subject: (LinkedInResolveClaim & { live: boolean }) | null }
  | { kind: "reply_check"; subject: (LinkedInReplyCheckClaim & { live: boolean }) | null }
  | { kind: "search"; rowLimit: number; subject: (SearchPageClaim & { live: boolean }) | null }
);

/** Persistence for the settle job. `close` is the fence: only the worker it answers true to writes the outcome. */
export interface LinkedInOpenOperationStore {
  /** Open actions, the ones looked at longest ago first. */
  listOpen(limit: number): Promise<OpenLinkedInOperation[]>;
  noteChecked(id: string, now: Date): Promise<void>;
  /** Removes the row. A crash right after this leaves its subject to the reconcile path, which never sends on a guess. */
  close(id: string): Promise<boolean>;
}

export interface LinkedInEngineDeps {
  store: LinkedInOutreachStore;
  /** The vendor read the thread and the person wrote, so nothing went out. Stops outreach to the person as a filed reply does, and gives the attempt back. The inbox read files the message later. */
  stopForReply(claim: LinkedInSettleClaim, now: Date): Promise<void>;
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
  /** A delivery of an event this app acts on that it could not read. Stored as given up, so a person sees it. */
  /** `key`: for a source that reads the same row again, so a repeat adds no second row. */
  recordUnreadable(input: { organizationId: string; provider: string; eventType: string; payload: unknown; now: Date; key?: string | null }): Promise<void>;
  begin(input: { organizationId: string; provider: string; key: string; eventType: string; accountRef: string; payload: unknown; now: Date }): Promise<LedgerEvent | null>;
  /** Settles the claim. A worker whose lease ran out, or whose row an admin requeued and another claim took, changes nothing. */
  finish(claim: LedgerEvent, status: "done" | "skipped", note: string | null, now: Date): Promise<void>;
  fail(claim: LedgerEvent, error: string, now: Date, retryAt: Date | null): Promise<void>;
  /**
   * `processing` rows whose lease expired on their last attempt: no claim takes them again, so they turn `failed`, where
   * the backlog counts them as dead and an admin can replay them. Returns how many.
   */
  failStoppedAtCap(now: Date, organizationId?: string): Promise<number>;
  /** Failed rows due for retry, and `processing` rows whose lease expired. Claims them (attempt + 1, lease, fresh token) atomically. */
  claimReplayable(now: Date, limit: number, leaseSeconds: number, organizationId?: string): Promise<LedgerEvent[]>;
  /** Applies one event. Safe to run twice for the same event. */
  apply(organizationId: string, event: LinkedInInboundEvent, now: Date): Promise<{ result: InboundResult; note: string | null }>;
}

/** One step of reading an account's inbox. */
export interface LinkedInInboundRead {
  /** Raw deliveries for the same ledger a webhook goes through. */
  deliveries: unknown[];
  /** Where the next step starts. Its shape belongs to the vendor's adapter. */
  cursor: unknown;
  /** Set on the step that ends a full read: when that read started. */
  finishedRunStartedAt: Date | null;
}

/** For a vendor that sends no webhook for messages. Throws a LinkedInGatewayError when it cannot read. */
export interface LinkedInInboundSource {
  read(input: { organizationId: string; provider: string; account: string; cursor: unknown; now: Date }): Promise<LinkedInInboundRead>;
}

export interface LinkedInInboundPollStore {
  /** Connected accounts on such a vendor last read before `readBefore` that nothing holds at `now`, oldest read first. */
  listDue(readBefore: Date, now: Date): Promise<Array<{ id: string; organizationId: string; provider: string; providerAccountId: string; workingHours: WorkingHours }>>;
  /** Holds the account until `until` and answers its cursor. Null: another worker holds it, or it was read or disconnected since the listing. */
  claim(accountId: string, input: { readBefore: Date; now: Date; until: Date }): Promise<{ cursor: unknown } | null>;
  saveCursor(accountId: string, cursor: unknown, finishedRunStartedAt: Date | null): Promise<void>;
  /** Ends the hold. `retryAt`: the next read waits until then. */
  release(accountId: string, retryAt: Date | null): Promise<void>;
  disconnect(accountId: string, error: string): Promise<void>;
}

export interface LinkedInInboundPollDeps {
  store: LinkedInInboundPollStore;
  source: LinkedInInboundSource;
  inbound: LinkedInInboundDeps;
  clock: Clock;
}

export interface LinkedInInboundDeps {
  store: LinkedInInboundStore;
  clock: Clock;
  /** Turns a raw provider payload into a normalized event, or null for payloads this app ignores. */
  parse: (payload: unknown) => LinkedInInboundEvent | null;
  /** The event's name when it is one this app acts on and `parse` could not read it. */
  unreadable?: (payload: unknown) => string | null;
  /** The ledger key of an unreadable delivery a source will read again. Null: every delivery counts on its own. */
  unreadableKey?: (payload: unknown, organizationId: string) => string | null;
  /** Idempotency key for the ledger. Null when the event has no id to key on. */
  eventKey: (event: LinkedInInboundEvent, organizationId: string, payload: unknown) => string | null;
}
