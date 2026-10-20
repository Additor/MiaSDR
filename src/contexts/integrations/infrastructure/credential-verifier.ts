import type { CredentialVerifier, VerifyFailure, VerifyResult } from "../application/credential-verifier";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
// Same version header as the Anthropic provider in the conversations context.
const ANTHROPIC_VERSION = "2023-06-01";
export const VERIFY_TIMEOUT_MS = 10_000;

export interface VerifierOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** True for providers that must make no network call (fake modes). */
  skip?: (providerKey: string) => boolean;
}

export type StatusMap = (status: number) => VerifyFailure | null;

export const standardStatus: StatusMap = (status) => {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "rejected";
  if (status === 429) return "rate_limited";
  return "unverifiable";
};

/** Keys are printable ASCII. Anything else (a smart quote, Hangul, a control character) makes fetch throw while it builds the headers, so the provider is never asked. */
export const headerSafe = (value: string) => !/[^\x20-\x7e]/.test(value);

export interface KeyCheckRequest {
  url: string;
  headers: Record<string, string>;
  map: StatusMap;
  /**
   * Reads the JSON body of a 2xx answer and returns a failure or null. Without it the body is never read: it could echo
   * request data. A 2xx body that is not a JSON object did not come from the vendor's API (a proxy page, a captive portal).
   */
  inspect?: (body: Record<string, unknown>) => VerifyFailure | null;
}

/** One fixed GET that checks a key. Redirects are refused, and no error, log line or return value carries the key. */
export type KeyCheck = (request: KeyCheckRequest) => Promise<VerifyResult>;

export function createKeyCheck(options: { fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {}): KeyCheck {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS;
  return async ({ url, headers, map, inspect }) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await doFetch(url, { method: "GET", headers, redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
      let failure = map(response.status);
      if (inspect && !failure) {
        const body: unknown = await response.json().catch(() => undefined);
        failure = body === null || typeof body !== "object" || Array.isArray(body) ? "unverifiable" : inspect(body as Record<string, unknown>);
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
      return failure ? { ok: false, reason: failure } : { ok: true, verified: true };
    } catch {
      return { ok: false, reason: "unreachable" };
    }
  };
}

/**
 * Verifies the Anthropic key with one fixed GET. The key travels in a header, never in a URL. Enrichment vendors check
 * their keys in the grid context, which owns them.
 */
export function createCredentialVerifier(options: VerifierOptions = {}): CredentialVerifier {
  return {
    async verify(providerKey, values, opts) {
      if (options.skip?.(providerKey)) return { ok: true, verified: false };
      const apiKey = values.apiKey;
      if (providerKey !== "anthropic") return { ok: true, verified: false };
      if (!apiKey || !headerSafe(apiKey)) return { ok: false, reason: "rejected" };
      const check = createKeyCheck({ fetch: options.fetch, timeoutMs: options.timeoutMs, signal: opts?.signal });
      return check({ url: ANTHROPIC_MODELS_URL, headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, accept: "application/json" }, map: standardStatus });
    },
  };
}
