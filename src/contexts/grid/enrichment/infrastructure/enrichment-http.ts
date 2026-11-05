import { pinnedFetch, safeRequestBytes, SafeHttpError, type Resolver, type SafeFetchDeps, type Transport } from "@/platform/safe-http/safe-http";
import { ProviderError } from "../application/enrichment-ports";

export { pinnedFetch, type Resolver, type SafeFetchDeps, type Transport };

export interface SafeResponse {
  status: number;
  contentType: string;
  text: string;
  /** The `retry-after` header as sent, or null. */
  retryAfter: string | null;
  /** Every response header, for vendors that put rate-limit resets or credits in their own headers. */
  headers: Headers;
}

/** The refusal a person reads under a provider column, for each way the request failed. */
function asProviderError(error: SafeHttpError): ProviderError {
  switch (error.failure) {
    case "scheme":
      return new ProviderError("Provider calls must use https.", false);
    case "unresolved":
      return new ProviderError(`Could not resolve ${error.host}.`, true);
    case "blocked":
      return new ProviderError("That address is private or internal and cannot be called.", false);
    case "timeout":
      return new ProviderError(`The provider did not answer within ${error.timeoutMs} ms.`, true);
    case "unreachable":
      return new ProviderError("Could not reach the provider.", true);
    case "redirect":
      return new ProviderError("The provider answered with a redirect. Redirects are not followed.", false);
    case "too_large":
      return new ProviderError("Response too large: the provider's answer is over 1 MiB.", false);
    case "cut_off":
      return new ProviderError("The provider's answer was cut off.", true);
  }
}

/**
 * One outbound call through the platform's safe request: no redirects, a body cap and a timeout.
 * The host allow-list (see `parseProviderBaseUrl`) is what keeps a tenant from pointing a provider at a server it controls.
 */
export async function safeRequest(url: URL, init: { method: string; headers: Record<string, string>; body?: string }, timeoutMs: number, deps: SafeFetchDeps = {}): Promise<SafeResponse> {
  try {
    const response = await safeRequestBytes(url, init, timeoutMs, deps);
    return { status: response.status, contentType: response.contentType, text: Buffer.from(response.bytes).toString("utf8"), retryAfter: response.retryAfter, headers: response.headers };
  } catch (error) {
    throw error instanceof SafeHttpError ? asProviderError(error) : error;
  }
}

export function parseBody(response: SafeResponse): unknown {
  const trimmed = response.text.trimStart();
  if (response.contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(response.text);
    } catch {
      return response.text;
    }
  }
  return response.text;
}

/** 4xx other than 408 and 429 is the request being wrong and fails the same way again. */
export const isTransientStatus = (status: number) => status === 408 || status === 429 || status >= 500;
