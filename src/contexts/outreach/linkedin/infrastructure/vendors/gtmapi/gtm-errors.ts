import { LinkedInGatewayError, type GatewayErrorCode } from "../../../application/linkedin-ports";
import { GtmRequestError } from "./gtm-http";

/** Nothing went out and the account comes back by itself, so no attempt is used up. gtm-api names when to retry. */
const COMES_BACK = new Set([
  "browser_starting",
  "browser_unavailable",
  "browser_unreachable",
  "plugin_unavailable",
  "infrastructure_maintenance",
  "client_rate_limited",
  "initial_sync_pending",
]);
/**
 * Nothing went out, and the refusal is about this person's thread. How the reply check behaves for someone with no thread is
 * not documented, so pausing the account could stop it for good: this lead would stay at the front of the queue, and its attempt comes back each time.
 */
const THREAD_BUSY = new Set(["concurrent_send_in_flight", "reply_check_unavailable"]);
/** The account cannot act until someone signs in or changes something at gtm-api. */
const ACCOUNT_LOST = new Set(["browser_logged_out", "subscription_required", "account_shared_out", "sender_not_ready"]);
/** A daily or per-action budget, or LinkedIn's own quota. */
const LIMITS = new Set(["bucket_saturated"]);
const NO_ACCESS = new Set(["sales_nav_required", "recruiter_reauth_required"]);
const NO_SUCH_PERSON = new Set(["target_unresolvable", "target_unavailable", "target_blocked"]);

const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 48 * 3_600_000;
const HOLD_MS = 5 * 60_000;
const BUDGET_HOLD_MS = 60 * 60_000;

/** `retry_after` is a timestamp. An unreadable one is none, and a wild one stays inside limits a person would accept. */
export function retryAfterMs(value: unknown, now: number): number | null {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now, MIN_RETRY_MS), MAX_RETRY_MS);
}

export interface GtmErrorContext {
  /** A call that changes something at LinkedIn. With no `send_outcome`, its error says nothing about what happened. */
  write?: boolean;
  /** What a limit on this call stops. An invitation's or a lookup's budget leaves messages and replies free. */
  limits?: "account" | "invitations";
  now?: number;
}

/**
 * A gtm-api failure as the port's. The reason comes before the outcome, because a place block answers `not_sent` and asks for
 * the same request again later. Anything that may have gone out stays `unknown`: a retry under the same key is answered, not re-sent.
 */
export function gatewayErrorFrom(error: unknown, context: GtmErrorContext = {}): LinkedInGatewayError {
  if (!(error instanceof GtmRequestError)) return new LinkedInGatewayError(`gtm-api call failed: ${error instanceof Error ? error.name : "unknown error"}`, "unknown", "unavailable");
  const now = context.now ?? Date.now();
  const text = `gtm-api: ${error.message} (${error.reason || error.code || `HTTP_${error.status}`})`;
  const definite = (code: GatewayErrorCode, retryMs: number | null = null, limits: LinkedInGatewayError["limits"] = "account") => new LinkedInGatewayError(text, "definite", code, retryMs, limits);
  const lost = () => new LinkedInGatewayError(text, "unknown", "unavailable");
  const { status, code, reason, sendOutcome } = error;
  const retry = retryAfterMs(error.retryAfter, now);

  if (!error.enveloped) return lost();
  if (reason === "replied") return definite("replied");
  if (THREAD_BUSY.has(reason)) return definite("rate_limited", retry ?? HOLD_MS, "recipient");
  if (COMES_BACK.has(reason)) return definite("rate_limited", retry ?? HOLD_MS);
  if (LIMITS.has(reason) || code === "limit_exceeded" || code === "payment_required") return definite("rate_limited", retry ?? BUDGET_HOLD_MS, context.limits ?? "account");
  if (sendOutcome && sendOutcome !== "not_sent") return lost();
  if (code === "unauthorized" || status === 401 || ACCOUNT_LOST.has(reason)) return definite("auth");
  if (code === "rate_limited" || status === 429) return definite("rate_limited", retry ?? HOLD_MS, context.limits ?? "account");
  if (reason === "resend_not_available") {
    if (error.cause_ === "pending") return definite("already_invited");
    if (error.cause_ === "accepted") return definite("already_connected");
    return definite("rejected");
  }
  if (reason === "not_connected") return definite("not_first_degree");
  if (NO_ACCESS.has(reason)) return definite("insufficient_privileges");
  if (NO_SUCH_PERSON.has(reason)) return definite("not_found");
  if (status >= 500) return sendOutcome === "not_sent" ? definite("rate_limited", retry ?? HOLD_MS) : lost();
  // The rule is that every send error carries an outcome, so one without it is not an answer about the send.
  if (context.write && !sendOutcome) return lost();
  if (code === "not_found" || code === "relation_not_found") return definite("not_found");
  return definite("rejected");
}
