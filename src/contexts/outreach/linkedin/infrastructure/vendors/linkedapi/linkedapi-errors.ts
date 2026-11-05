import { LinkedInGatewayError, type GatewayErrorCode } from "../../../application/linkedin-ports";
import type { OpenOperationKind } from "../../../domain/linkedin-operations";
import { LinkedApiRequestError } from "./linkedapi-http";

const HOUR_MS = 3_600_000;
/** On a submit it means nothing started, so a short wait is enough. */
const TOO_MANY_REQUESTS_MS = 5 * 60_000;

/** A refusal whose sentence a person can act on, which `explain` passes on as it stands. */
export class LinkedApiPlainError extends LinkedInGatewayError {}

const plain = (sentence: string, code: GatewayErrorCode, retryAfterMs: number | null = null, limits: "account" | "invitations" = "account") => new LinkedApiPlainError(sentence, "definite", code, retryAfterMs, limits);

const NOT_RECIPIENT = new Set(["emailRequired", "noteTooLong", "selfProfileNotAllowed"]);
const NOT_FOUND = new Set(["personNotFound", "personLikelyChangedPublicUrl"]);
const AUTH = new Set(["linkedinAccountSignedOut", "invalidLinkedApiToken", "linkedApiTokenRequired", "identificationTokenRequired", "invalidIdentificationToken"]);
const REJECTED = new Set(["invalidWorkflow", "invalidRequestPayload", "filterNotApplied"]);

/** Limits that stop the kind of work and leave the account's messages and replies free. A search that hits one waits alone. */
const stopsInvitations = (kind: OpenOperationKind | null) => kind === "invitation" || kind === "lookup" || kind === "search";

/** What Linked API's error type means here. Null: nobody knows what it did, so a write may have gone out. */
export function refusalFrom(type: string, message: string, kind: OpenOperationKind | null): LinkedInGatewayError | null {
  const text = message || `Linked API refused (${type}).`;
  if (AUTH.has(type)) return new LinkedInGatewayError(text, "definite", "auth");
  if (type === "subscriptionRequired") return plain("This Linked API account has no active seat. Renew it in Linked API.", "rate_limited", HOUR_MS);
  if (type === "languageNotSupported") return plain("Linked API does not support this account's LinkedIn interface language. Switch it to English, German, Spanish, French or Portuguese, then try again.", "rate_limited", HOUR_MS);
  if (type === "plusPlanRequired" || type === "noSalesNavigator") return plain("This needs Sales Navigator on the LinkedIn account and a Linked API Plus seat.", kind === "lookup" ? "insufficient_privileges" : "rejected");
  // The vendor's guide says to stop the batch, and nothing about this person. A lead always refused retries hourly.
  if (type === "requestNotAllowed") return plain("LinkedIn refused this connection request. Invitations wait an hour.", "rate_limited", HOUR_MS, "invitations");
  if (type === "noteLimitExceeded") return plain("LinkedIn limits personalized invitations on this account. Invitations wait a day, because a note someone wrote is not dropped.", "rate_limited", 24 * HOUR_MS, "invitations");
  if (type === "limitExceeded") return new LinkedInGatewayError(text, "definite", "rate_limited", null, stopsInvitations(kind) ? "invitations" : "account");
  if (type === "messagingNotAllowed") return /limit/i.test(message) ? new LinkedInGatewayError(text, "definite", "rate_limited") : new LinkedInGatewayError(text, "definite", "not_first_degree");
  if (type === "alreadyPending" || type === "invitationAlreadyReceived") return new LinkedInGatewayError(text, "definite", "already_invited");
  if (type === "alreadyConnected") return new LinkedInGatewayError(text, "definite", "already_connected");
  if (NOT_RECIPIENT.has(type)) return new LinkedInGatewayError(text, "definite", "invalid_recipient");
  if (NOT_FOUND.has(type)) return new LinkedInGatewayError(text, "definite", "not_found");
  if (type === "tooManyRequests") return new LinkedInGatewayError(text, "definite", "rate_limited", TOO_MANY_REQUESTS_MS);
  if (type === "outsideWorkingHours" || type === "workingHoursWaitExpired") return plain("Linked API held this for the account's working hours, so it did not run. Set a window over MiaSDR's in Linked API, with its policy on Run anyway.", "rate_limited", HOUR_MS);
  if (type === "searchingNotAllowed") return new LinkedInGatewayError(text, "definite", "rate_limited", null, "invitations");
  if (REJECTED.has(type)) return new LinkedInGatewayError(text, "definite", "rejected");
  return null;
}

const ADMIN_SENTENCES: Record<string, string> = {
  noAvailableSeats: "Your Linked API plan has no free seat. Add one in Linked API, then make the link again.",
  dailyConnectionAttemptsExceeded: "Linked API limits connection attempts per day. Try again tomorrow.",
  // A `frozen` account has no reconnect at the vendor: its seat lapsed.
  invalidRequestPayload: "Linked API cannot reconnect this account. If its seat lapsed, renew it in Linked API, then choose Sync accounts.",
};

/** A refusal of a connect link, in words a person can act on. */
export function adminRefusal(error: unknown): LinkedApiPlainError | null {
  const sentence = error instanceof LinkedApiRequestError ? ADMIN_SENTENCES[error.type] : undefined;
  return sentence ? plain(sentence, "rejected") : null;
}

/** A failed call. A request Linked API refused put nothing on LinkedIn. Without such an answer, a write may have run. */
export function gatewayErrorFrom(error: unknown, kind: OpenOperationKind | null = null): LinkedInGatewayError {
  if (error instanceof LinkedInGatewayError) return error;
  if (!(error instanceof LinkedApiRequestError)) return new LinkedInGatewayError(error instanceof Error ? error.message : "Linked API failed.", "unknown", "unavailable");
  const known = error.type ? refusalFrom(error.type, error.message, kind) : null;
  if (known) return known;
  if (error.status === 401) return new LinkedInGatewayError(error.message, "definite", "auth");
  if (error.status === 429) return new LinkedInGatewayError(error.message, "definite", "rate_limited", TOO_MANY_REQUESTS_MS);
  // Only an error Linked API named vouches that nothing ran. A bare 4xx may come from something in between, after the call got through.
  if (error.status >= 400 && error.status < 500 && error.type && error.type !== "unexpectedError") return new LinkedInGatewayError(error.message, "definite", "rejected");
  return new LinkedInGatewayError(error.message, "unknown", "unavailable");
}

/** A workflow that ended with an error. An error type this does not know says nothing about what the action did. */
export function workflowFailure(type: string, message: string, kind: OpenOperationKind): LinkedInGatewayError {
  return refusalFrom(type, message, kind) ?? new LinkedInGatewayError(message || `Linked API could not finish this (${type || "no reason"}).`, "unknown", "unavailable");
}
