import { LinkedInGatewayError, type GatewayErrorCode } from "../../../application/linkedin-ports";
import { EdgesRequestError } from "./edges-http";

/** The account's connection to LinkedIn is gone: it needs a new sign-in. */
const RECONNECT = new Set(["LK_BAD_COOKIE", "LK_LOGIN_ERROR", "MISSING_COOKIE", "NO_VALID_ACCOUNT_CONFIGURED", "INVALID_INTEGRATION"]);
/** The start of the label for an identity that no longer exists at Edges. */
export const IDENTITY_GONE = "WORKSPACE_IDENTITY_404";
/** Refused for this person: nothing went out, and trying again changes nothing. */
const REFUSED = new Set(["STATUS_404", "NO_RESULT", "NO_DATA_AVAILABLE", "BAD_INPUT", "BAD_PARAMETERS", "MISSING_PARAMETER", "MANDATORY_DATA_MISSING", "UNDEFINED_FIELD", "SN_OUT_OF_NETWORK", "LK_MISSING_DATA"]);
/** Broke while the action ran, or the answer was lost: a write may be half done. */
const LOST = new Set(["LK_524", "API_TIMEOUT_ERROR", "LK_API_MAX_RETRY", "ACTION_ABORTED", "GENERIC_ERROR", "UNKNOWN_ERROR", "LK_ERROR", "PROXY_ERROR"]);
/** `LIMIT_REACHED` windows that are pacing, not the account's quota. */
const SHORT_WINDOW = /MINUTE|15M|HOUR|RATE_LIMIT/i;

const PACING_MS = 5 * 60_000;
/** The account cannot act for now (its plan, a temporary restriction). It comes back without anyone reconnecting, so the attempt is not used up. */
const HOLD_MS = 60 * 60_000;

/** `auth` about one account's sign-in, not the API key. The engines treat both alike, and only the sentence for a person differs. */
export class EdgesSignInLostError extends LinkedInGatewayError {}

const reasonOf = (error: EdgesRequestError) => {
  const code = error.label || (error.status ? `HTTP_${error.status}` : "UNREACHABLE");
  return `Edges: ${error.message} (${error.appendix ? `${code}:${error.appendix}` : code})`;
};

/**
 * An Edges failure as the port's. Anything that might have run stays `unknown`: no Edges write takes an idempotency key,
 * so it is settled by reading back, never by retrying on a guess.
 */
export function gatewayErrorFrom(error: unknown, now: number = Date.now()): LinkedInGatewayError {
  if (!(error instanceof EdgesRequestError)) return new LinkedInGatewayError(`Edges call failed: ${error instanceof Error ? error.name : "unknown error"}`, "unknown", "unavailable");
  const reason = reasonOf(error);
  const { label, status, appendix } = error;
  const definite = (code: GatewayErrorCode, retryAfterMs: number | null = null) => new LinkedInGatewayError(reason, "definite", code, retryAfterMs);

  if (label === "LIMIT_REACHED") {
    // A cap on invitation notes is about this lead's note, and must not stop the account's messages and replies.
    if (/\bnotes?\b|personali[sz]ed/i.test(`${error.message} ${appendix ?? ""}`)) return definite("invalid_recipient");
    const window = `${appendix ?? ""} ${String(error.params?.timespan ?? "")}`;
    const short = SHORT_WINDOW.test(window) || error.params?.error === "all integration identities exceed identity rate limits";
    return definite("rate_limited", error.retryAfterMs(now) ?? (short ? PACING_MS : null));
  }
  if (label === "STATUS_429") return definite("rate_limited", error.retryAfterMs(now));
  if (label === "RATE_LIMITED" || status === 429) return definite("rate_limited", error.retryAfterMs(now) ?? PACING_MS);
  if (label === "INVALID_INTEGRATION" && /TEMPORARILY_RESTRICTED/i.test(appendix ?? "")) return definite("rate_limited", HOLD_MS);
  if (RECONNECT.has(label) || label.startsWith(IDENTITY_GONE)) return new EdgesSignInLostError(reason, "definite", "auth");
  if (status === 401) return definite("auth");
  // Out of credits, or the plan or workspace does not allow it: the attempt comes back later and the account stays connected.
  if (label === "INTEGRATION_ERROR" || label === "NO_ACCESS" || status === 402 || status === 403) return definite("rate_limited", HOLD_MS);
  if (label === "PROXY_ERROR" && /NO_PROXY_IP/i.test(appendix ?? "")) return definite("rate_limited", PACING_MS);
  if (label === "NOT_CONNECTED") return definite("not_first_degree");
  if (label === "LK_ERROR" && /cannot re-send connection request yet/i.test(error.message)) return definite("invalid_recipient");
  if (label === "LK_ERROR" && (/^Error while getting\b/i.test(error.message) || status === 400)) return definite("not_found");
  if (REFUSED.has(label)) return definite("not_found");
  if (status === 0 || status >= 500 || LOST.has(label)) return new LinkedInGatewayError(reason, "unknown", "unavailable");
  // An unnamed 424 is LinkedIn's side failing mid-action.
  if (status === 408 || status === 424) return new LinkedInGatewayError(reason, "unknown", "unavailable");
  return definite("rejected");
}
