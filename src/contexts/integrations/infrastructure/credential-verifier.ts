import type { CredentialVerifier, VerifyFailure, VerifyResult } from "../application/credential-verifier";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
// Same version header as the Anthropic provider in the conversations context.
const ANTHROPIC_VERSION = "2023-06-01";
const HUNTER_ACCOUNT_URL = "https://api.hunter.io/v2/account";
// Apollo lists GET /auth/health in its authentication docs (2026-10-16) without a bad-key status. Not run live.
const APOLLO_HEALTH_URL = "https://api.apollo.io/api/v1/auth/health";
export const VERIFY_TIMEOUT_MS = 10_000;

export interface VerifierOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** True for providers that must make no network call (fake modes). */
  skip?: (providerKey: string) => boolean;
}

type StatusMap = (status: number) => VerifyFailure | null;

const standard: StatusMap = (status) => {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "rejected";
  if (status === 429) return "rate_limited";
  return "unverifiable";
};

// Hunter answers 403 for usage limits, which clear on their own. 401 is a bad key.
const hunter: StatusMap = (status) => (status === 403 ? "rate_limited" : standard(status));

/** Keys are printable ASCII. Anything else (a smart quote, Hangul, a control character) makes fetch throw while it builds the headers, so the provider is never asked. */
const headerSafe = (value: string) => !/[^\x20-\x7e]/.test(value);

/**
 * Verifies keys with one fixed GET per provider. The key travels in a header, never in a URL, and no
 * error, log line or return value carries it. `http` and `fake` providers have no verifier.
 */
export function createCredentialVerifier(options: VerifierOptions = {}): CredentialVerifier {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;

  async function call(url: string, headers: Record<string, string>, map: StatusMap, signal?: AbortSignal, loggedIn?: boolean): Promise<VerifyResult> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await doFetch(url, { method: "GET", headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      let failure = map(response.status);
      if (loggedIn && !failure) {
        // Apollo health: only the `is_logged_in` flag is read, and nothing else leaves this block.
        // A 200 that is not a JSON object (a proxy page, a captive portal) did not come from Apollo's API, so it proves nothing.
        const body: unknown = await response.json().catch(() => undefined);
        if (body === null || typeof body !== "object" || Array.isArray(body)) failure = "unverifiable";
        else if ((body as { is_logged_in?: unknown }).is_logged_in === false) failure = "rejected";
      } else {
        // The body is never read: it could echo request data.
        await response.body?.cancel().catch(() => undefined);
      }
      return failure ? { ok: false, reason: failure } : { ok: true, verified: true };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  }

  return {
    async verify(providerKey, values, opts) {
      if (options.skip?.(providerKey)) return { ok: true, verified: false };
      const apiKey = values.apiKey;
      switch (providerKey) {
        case "anthropic":
          if (!apiKey || !headerSafe(apiKey)) return { ok: false, reason: "rejected" };
          return call(ANTHROPIC_MODELS_URL, { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" }, standard, opts?.signal);
        case "hunter":
          if (!apiKey || !headerSafe(apiKey)) return { ok: false, reason: "rejected" };
          return call(HUNTER_ACCOUNT_URL, { "X-API-KEY": apiKey, accept: "application/json" }, hunter, opts?.signal);
        case "apollo":
          if (!apiKey || !headerSafe(apiKey)) return { ok: false, reason: "rejected" };
          return call(APOLLO_HEALTH_URL, { "x-api-key": apiKey, accept: "application/json" }, standard, opts?.signal, true);
        default:
          return { ok: true, verified: false };
      }
    },
  };
}
