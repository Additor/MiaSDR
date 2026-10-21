import type { VerifyFailure, VerifyResult } from "./verify";

export const VERIFY_TIMEOUT_MS = 10_000;


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
