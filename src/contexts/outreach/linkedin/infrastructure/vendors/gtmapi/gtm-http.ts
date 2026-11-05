/**
 * gtm-api's LinkedIn service: the team's key as a Bearer token. Every call is a POST with a JSON body and answers one envelope.
 * Errors are `{ success: false, error: { code, message, field_errors, context } }`. A send's error carries `context.send_outcome`.
 */
const BASE = "https://app.gtm-api.com/linkedin/v4";
/** A send runs in a browser and the server may sleep up to 20 s to pace it. A `check-sent` can take as long as an inbox read. A slow one reads as an unknown outcome. */
const WRITE_TIMEOUT_MS = 45_000;
/** Reads of gtm-api's own store. A poll runs inside a share of one tick. */
const READ_TIMEOUT_MS = 15_000;

export type SendOutcome = "sent" | "not_sent" | "in_flight" | "unknown";

/** A refused or failed call. `status` 0, or `enveloped` false: no answer gtm-api vouches for, so a write may or may not have run. */
export class GtmRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly enveloped: boolean = false,
    readonly code: string = "",
    /** Why, from `context.reason`, or the failed rule on `validation_failed`. */
    readonly reason: string = "",
    readonly cause_: string = "",
    readonly sendOutcome: SendOutcome | null = null,
    readonly retryAfter: unknown = null,
  ) {
    super(message);
  }
}

export const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asString = (value: unknown) => (typeof value === "string" ? value : "");

function firstRule(fieldErrors: unknown): string {
  for (const rules of Object.values(obj(fieldErrors))) {
    const rule = Array.isArray(rules) ? asString(obj(rules[0]).rule) : "";
    if (rule) return rule;
  }
  return "";
}

function errorFrom(status: number, parsed: unknown): GtmRequestError {
  const error = obj(obj(parsed).error);
  const code = asString(error.code);
  if (!code) return new GtmRequestError(status, `gtm-api answered ${status}`);
  const context = obj(error.context);
  const outcome = asString(context.send_outcome);
  return new GtmRequestError(
    status,
    asString(error.message) || `gtm-api answered ${status}`,
    true,
    code,
    asString(context.reason) || firstRule(error.field_errors),
    asString(context.cause),
    outcome === "sent" || outcome === "not_sent" || outcome === "in_flight" || outcome === "unknown" ? outcome : null,
    context.retry_after ?? null,
  );
}

export interface GtmClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
}

export class GtmClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: GtmClientOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(`${BASE}${path}`, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch {
      throw new GtmRequestError(0, "gtm-api did not answer.");
    }
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // A garbled success is no answer: a read must not take it for an empty list.
      if (response.ok) throw new GtmRequestError(0, "gtm-api answered something other than JSON.");
    }
    if (!response.ok) throw errorFrom(response.status, parsed);
    return obj(parsed);
  }

  read(path: string, body: unknown = {}): Promise<Record<string, unknown>> {
    return this.post(path, body, READ_TIMEOUT_MS);
  }

  write(path: string, body: unknown): Promise<Record<string, unknown>> {
    return this.post(path, body, WRITE_TIMEOUT_MS);
  }
}
