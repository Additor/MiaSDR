/**
 * Linked API's two APIs. The Admin API is `POST /admin/<resource>.<action>` with the organization's token. The account API
 * (`/workflows`, `/inbox/poll`, `/network/poll`) also takes the LinkedIn account's identification token, which only the Admin
 * API's listing gives. Every answer is `{ success, result }` or `{ success: false, error: { type, message } }`.
 */
const BASE = "https://api.linkedapi.io";
/** A submit answers at once and the reads are of Linked API's own store, inside a share of one tick. */
const TIMEOUT_MS = 15_000;
/** How long a listing, and so each account's identification token, is reused. */
const LISTING_MS = 30_000;

/** `status` 0, or a type of `""`: no answer Linked API vouches for, so a write may or may not have run. */
export class LinkedApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LinkedApiAccountRow {
  id: string;
  name?: string | null;
  url?: string | null;
  avatarUrl?: string | null;
  headline?: string | null;
  identificationToken?: string | null;
  status?: string | null;
  connectedAt?: string | null;
}

export interface LinkedApiClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
}

/** By token, because the jobs build a client per account and a listing per send would be one call too many. */
const listings = new Map<string, { at: number; accounts: LinkedApiAccountRow[] }>();

export class LinkedApiClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: LinkedApiClientOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  private async call(method: "GET" | "POST" | "DELETE", path: string, headers: Record<string, string>, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(`${BASE}${path}`, {
        method,
        headers: { accept: "application/json", "linked-api-token": this.options.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await response.text();
    } catch {
      throw new LinkedApiRequestError(0, "", "Linked API did not answer.");
    }
    let parsed: { success?: unknown; result?: unknown; error?: { type?: unknown; message?: unknown } } | null = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // A gateway page or a garbled success: nothing Linked API vouches for.
    }
    const type = typeof parsed?.error?.type === "string" ? parsed.error.type : "";
    if (response.ok && parsed?.success === true) return (parsed.result && typeof parsed.result === "object" ? parsed.result : {}) as Record<string, unknown>;
    throw new LinkedApiRequestError(parsed ? response.status : 0, type, typeof parsed?.error?.message === "string" ? parsed.error.message.slice(0, 300) : `Linked API answered ${response.status}.`);
  }

  admin(endpoint: string, body: unknown = {}): Promise<Record<string, unknown>> {
    return this.call("POST", `/admin/${endpoint}`, {}, body);
  }

  async listAccounts(fresh = false): Promise<LinkedApiAccountRow[]> {
    const cached = listings.get(this.options.apiKey);
    if (!fresh && cached && Date.now() - cached.at < LISTING_MS) return cached.accounts;
    const result = await this.admin("accounts.getAll");
    const accounts = Array.isArray(result.accounts) ? (result.accounts as LinkedApiAccountRow[]).filter((row) => typeof row?.id === "string") : [];
    listings.set(this.options.apiKey, { at: Date.now(), accounts });
    return accounts;
  }

  forgetListing(): void {
    listings.delete(this.options.apiKey);
  }

  private async tokenOf(account: string, fresh: boolean): Promise<string> {
    const rows = await this.listAccounts(fresh).catch((error: unknown) => {
      // No token means no call: nothing started, so this reads as a short wait and never as a send that may have gone out.
      if (error instanceof LinkedApiRequestError && error.status === 401) throw error;
      throw new LinkedApiRequestError(429, "tooManyRequests", "Linked API did not list its accounts, so nothing started.");
    });
    const token = rows.find((row) => row.id === account)?.identificationToken;
    if (token) return token;
    // A listing up to 30 s old may not hold an account that just connected.
    if (!fresh) return this.tokenOf(account, true);
    throw new LinkedApiRequestError(401, "invalidIdentificationToken", "Linked API lists no such account.");
  }

  /** A call as one account. A token Linked API no longer takes gets one fresh listing: a reconnect changes it. */
  async account(account: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Record<string, unknown>> {
    const send = async (fresh: boolean) => this.call(method, path, { "identification-token": await this.tokenOf(account, fresh) }, body);
    try {
      return await send(false);
    } catch (error) {
      if (!(error instanceof LinkedApiRequestError) || error.type !== "invalidIdentificationToken") throw error;
      this.forgetListing();
      return send(true);
    }
  }
}
