import type { VerifyResult } from "@/contexts/integrations/application/credential-verifier";
import type { KeyCheck } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer, type ProviderCall } from "../../application/enrichment-ports";
import type { VendorAdapterKey } from "../../domain/enrichment-catalog";
import { hasCellValue } from "../../domain/enrichment-templates";
import { isTransientStatus, type SafeFetchDeps, type SafeResponse } from "../enrichment-http";

/**
 * One enrichment vendor with a fixed host. Each definition builds its own requests and reads its own answers, so a
 * vendor's quirks stay in its file; the helpers below keep the shared rules (null filling, error text, retry-after) in one place.
 */
export interface VendorDefinition {
  /** The catalog key, and the `config.adapter` value stored on provider rows. */
  readonly key: VendorAdapterKey;
  execute(call: ProviderCall, net: SafeFetchDeps): Promise<ProviderAnswer>;
  /** Checks a key with one call that spends no credits. The key is printable ASCII by the time it gets here. */
  checkKey(apiKey: string, check: KeyCheck): Promise<VerifyResult>;
}

export const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The first useful sentence of a vendor's error body, never more than 300 characters. */
export function errorSnippet(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  const root = asRecord(body);
  const errors = root.errors;
  const first = Array.isArray(errors) ? asRecord(errors[0]) : asRecord(errors);
  // Apollo moves its error text to `error_details` and drops the root fields on 2027-02-16.
  const details = root.error_details;
  for (const value of [first.details, first.detail, first.message, asRecord(details).message, details, root.message, (root.error as { message?: unknown } | undefined)?.message, root.error]) {
    if (typeof value === "string" && value) return value.slice(0, 300);
  }
  return "request failed";
}

const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 60 * 60_000;

/**
 * `retry-after` is a number of seconds or an HTTP date. A missing or odd value waits a minute; a long one is capped at
 * an hour.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return DEFAULT_WAIT_MS;
  const date = /^\s*\d+(\.\d+)?\s*$/.test(header) ? NaN : Date.parse(header);
  const seconds = Number.isFinite(date) ? (date - now) / 1000 : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(1000, Math.ceil(seconds * 1000)));
}

/**
 * How long a rate-limited vendor asks you to wait. `retry-after` comes first, then the vendors' own headers: Prospeo's
 * reset seconds (the daily one once the day's requests are gone) and People Data Labs' `x-ratelimit-reset` time.
 */
export function rateLimitWaitMs(response: SafeResponse, now = Date.now()): number {
  if (response.retryAfter) return retryAfterMs(response.retryAfter, now);
  const header = (name: string) => response.headers?.get(name) ?? null;
  const daily = header("x-daily-reset-seconds");
  if (daily && header("x-daily-request-left") === "0") return retryAfterMs(daily, now);
  const minute = header("x-minute-reset-seconds");
  if (minute) return retryAfterMs(minute, now);
  return retryAfterMs(header("x-ratelimit-reset"), now);
}

/**
 * A hit when `primary` holds a value, a miss otherwise. `hit: false` makes a miss that keeps its verdict (a catch-all
 * address). Every output the vendor left out or sent blank becomes null, and strings lose their outer spaces. `response`
 * stays as the vendor sent it, so the ledger shows the raw answer.
 */
export function answerWith(outputs: Record<string, unknown>, primary: unknown, request: unknown, response: unknown, options: { hit?: boolean; billable?: boolean } = {}): ProviderAnswer {
  const present = hasCellValue(primary);
  const found = present && options.hit !== false;
  return {
    outcome: found ? "hit" : "miss",
    primary: present ? primary : null,
    outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, typeof v === "string" ? text(v) : (v ?? null)])),
    ...(options.billable === false ? { billable: false } : {}),
    request,
    response,
  };
}

/**
 * The shared reading of a failed status: 401 means the key, 403 the key or the plan's reach (or a usage limit, for a
 * vendor that says so), 402 means credits, 429 waits as the vendor asks, and 408 and 5xx are worth asking again.
 * Everything else fails the same way next time.
 */
export function statusError(vendor: string, response: SafeResponse, body: unknown, request: unknown, options: { forbiddenIsLimit?: boolean } = {}): ProviderError {
  const detail = `${vendor} returned ${response.status}: ${errorSnippet(body)}`;
  const audit = { request, response: body };
  if (response.status === 401) return new ProviderError(`${detail} Check the ${vendor} API key.`, false, audit);
  if (response.status === 403 && options.forbiddenIsLimit) return new ProviderError(detail, true, audit, rateLimitWaitMs(response));
  if (response.status === 403) return new ProviderError(`${detail} Check the ${vendor} API key, and whether your plan includes this endpoint.`, false, audit);
  if (response.status === 402) return new ProviderError(`${detail} The ${vendor} account is out of credits.`, false, audit);
  if (response.status === 429) return new ProviderError(detail, true, audit, rateLimitWaitMs(response));
  return new ProviderError(detail, isTransientStatus(response.status), audit);
}

/** A LinkedIn profile URL with a scheme. Some vendors send `linkedin.com/in/x`. */
export const withScheme = (value: unknown): string | null => {
  const url = text(value);
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
};
