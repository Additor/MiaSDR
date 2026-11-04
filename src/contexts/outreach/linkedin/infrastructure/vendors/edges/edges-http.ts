/**
 * Edges' API: the organization's key as `X-API-Key`. Live actions run as one identity and answer in the call; a list's next
 * page is the `X-Pagination-Next` header's cursor. Errors are `{ error_label, message, params }`, and LinkedIn-side ones are
 * 424 with a label.
 */
const BASE = "https://api.edges.run/v1";
/** A write runs a browser session at Edges. It stays under the job route's limit, so a slow write reads as an unknown outcome. */
const WRITE_TIMEOUT_MS = 45_000;
/** Reads took up to 6 s when measured. A poll runs inside a share of one tick. */
const READ_TIMEOUT_MS = 15_000;

/** A refused or failed call. `status` 0: no answer, so a write may or may not have run. */
export class EdgesRequestError extends Error {
  constructor(
    readonly status: number,
    readonly label: string,
    message: string,
    readonly appendix: string | null = null,
    readonly params: Record<string, unknown> | null = null,
  ) {
    super(message);
  }

  /** How long Edges says the limit lasts, when it says. */
  retryAfterMs(now: number): number | null {
    const raw = this.params?.postponed_until;
    const at = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    return Number.isNaN(at) ? null : Math.max(at - now, 0);
  }
}

export interface EdgesClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
}

const asObject = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

function errorFrom(status: number, parsed: unknown): EdgesRequestError {
  const body = asObject(parsed) ?? {};
  const platform = asObject(body.error);
  const params = asObject(body.params);
  const label = typeof body.error_label === "string" ? body.error_label : platform && status === 429 ? "RATE_LIMITED" : "";
  const message = typeof body.message === "string" && body.message ? body.message : typeof platform?.message === "string" ? platform.message : `Edges answered ${status}`;
  return new EdgesRequestError(status, label, message, typeof params?.appendix === "string" ? params.appendix : null, params);
}

function nextCursorFrom(header: string | null): string | null {
  if (!header) return null;
  try {
    return new URL(header).searchParams.get("cursor") || null;
  } catch {
    return null;
  }
}

export class EdgesClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: EdgesClientOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  private async send(method: "GET" | "POST" | "DELETE", path: string, body: unknown, timeoutMs: number): Promise<{ parsed: unknown; headers: Headers }> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(`${BASE}${path}`, {
        method,
        headers: { accept: "application/json", "X-API-Key": this.options.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch {
      throw new EdgesRequestError(0, "unreachable", "Edges did not answer.");
    }
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) throw errorFrom(response.status, parsed);
    return { parsed, headers: response.headers };
  }

  /** Runs one live action as `identity`. */
  async action<T = unknown>(slug: string, call: { identity: string; input?: Record<string, unknown>; parameters?: Record<string, unknown>; cursor?: string | null; write?: boolean }): Promise<{ body: T; nextCursor: string | null }> {
    const path = `/actions/${slug}/run/live${call.cursor ? `?cursor=${encodeURIComponent(call.cursor)}` : ""}`;
    const body = { identity_ids: [call.identity], ...(call.input ? { input: call.input } : {}), ...(call.parameters ? { parameters: call.parameters } : {}) };
    const { parsed, headers } = await this.send("POST", path, body, call.write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
    return { body: parsed as T, nextCursor: nextCursorFrom(headers.get("x-pagination-next")) };
  }

  /** A management call (identities, integrations, workspace). */
  async request<T = unknown>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    return (await this.send(method, path, body, READ_TIMEOUT_MS)).parsed as T;
  }
}
