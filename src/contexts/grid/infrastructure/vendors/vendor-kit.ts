import type { VerifyResult } from "@/contexts/integrations/application/credential-verifier";
import type { KeyCheck } from "@/contexts/integrations/infrastructure/credential-verifier";
import type { ProviderAnswer, ProviderCall } from "../../application/enrichment-ports";
import type { VendorAdapterKey } from "../../domain/enrichment-catalog";
import { hasCellValue } from "../../domain/enrichment-templates";
import type { SafeFetchDeps } from "../enrichment-http";

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
  for (const value of [first.details, first.detail, first.message, root.message, (root.error as { message?: unknown } | undefined)?.message, root.error]) {
    if (typeof value === "string" && value) return value.slice(0, 300);
  }
  return "request failed";
}

const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 60 * 60_000;

/** `retry-after` is a number of seconds. A missing or odd value waits a minute; a long one is capped at an hour. */
export function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (!header || !Number.isFinite(seconds) || seconds < 0) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(1000, Math.ceil(seconds * 1000)));
}

/**
 * A hit when `primary` holds a value, a miss otherwise. `hit: false` makes a miss that keeps its verdict (a catch-all
 * address). Every output the vendor left out becomes null.
 */
export function answerWith(outputs: Record<string, unknown>, primary: unknown, request: unknown, response: unknown, options: { hit?: boolean; billable?: boolean } = {}): ProviderAnswer {
  const present = hasCellValue(primary);
  const found = present && options.hit !== false;
  return {
    outcome: found ? "hit" : "miss",
    primary: present ? primary : null,
    outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v ?? null])),
    ...(options.billable === false ? { billable: false } : {}),
    request,
    response,
  };
}
