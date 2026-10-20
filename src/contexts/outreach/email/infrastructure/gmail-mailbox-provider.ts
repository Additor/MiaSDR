import { createSign } from "node:crypto";
import { ProviderSendError, type InboundBatch, type InboundEmail, type MailboxProvider, type OutgoingEmail, type SentEmail, type FindSentResult, type FindSentHint } from "../../application/ports";
import { parseGmailMessage, type GmailMessage } from "./gmail-inbound";
import { SEND_ID_HEADER, buildMime, toBase64Url } from "./gmail-mime";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];
const REQUEST_TIMEOUT_MS = 30_000;
const SCAN_PAGE_SIZE = 100;
/** Gmail lets a mailbox send about 2000 a day. Without a recipient hint, pages are sized from this bound plus headroom. */
const SENT_PER_DAY_BOUND = 2000;
const SCAN_PAGE_HEADROOM = 5;
/** With a recipient hint the scan covers one address, so a small fixed cap is already generous. */
const HINTED_MAX_PAGES = 10;
/**
 * `absent` needs a claim at least this old. Gmail's search index can lag behind a send, so a younger
 * claim that is not found yet is `inconclusive`, not proof of absence.
 */
export const FIND_SENT_INDEX_LAG_MS = 10 * 60_000;
const SAFE_ADDRESS = /^[^\s"'()<>,:;\\]+@[^\s"'()<>,:;\\]+$/;
/** Beyond this age a scan is too long to trust, so `findSent` answers `inconclusive` instead of scanning. */
export const FIND_SENT_HORIZON_MS = 30 * 24 * 3_600_000;
/** The search starts this long before the claim, to absorb clock skew between our host and Gmail's index. */
const FIND_SENT_MARGIN_MS = 3_600_000;
const DETAIL_CONCURRENCY = 5;
/** A cached token is dropped this long before Google would expire it. */
const EXPIRY_MARGIN_MS = 60_000;

export interface ServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
}

/** Reads the JSON key file Google issues. Never echoes its content in an error. */
export function parseServiceAccountJson(raw: string): ServiceAccountCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The Google service account key is not valid JSON.");
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  if (typeof obj.client_email !== "string" || typeof obj.private_key !== "string" || !obj.client_email || !obj.private_key) {
    throw new Error("The Google service account key needs client_email and private_key.");
  }
  return { clientEmail: obj.client_email, privateKey: obj.private_key };
}

export interface GmailProviderOptions {
  credentials: ServiceAccountCredentials;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/** A failure before any message left: the token could not be had. */
class TokenError extends Error {}

const DELEGATION_HINT =
  "Check that domain-wide delegation is enabled for the service account, that its client ID is authorized in the Google Workspace admin console " +
  "(Security, API controls, Domain-wide delegation) with the scopes gmail.send, gmail.readonly and gmail.modify, and that the mailbox exists in your Workspace domain.";

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** Gmail through a service account with domain-wide delegation, using plain `fetch` and an RS256 JWT. */
export class GmailMailboxProvider implements MailboxProvider {
  private readonly credentials: ServiceAccountCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<string>>();

  constructor(options: GmailProviderOptions) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async verify(emailAddress: string): Promise<void> {
    let token: string;
    try {
      token = await this.token(emailAddress);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Could not get a Google access token.");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${API}/profile`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new Error("Could not reach the Gmail API. Check the server's network access and try again.");
    }
    if (!response.ok) {
      this.tokens.delete(emailAddress);
      throw new Error(`Gmail refused access to ${emailAddress} (${response.status}: ${await apiMessage(response)}). ${DELEGATION_HINT}`);
    }
  }

  async send(email: OutgoingEmail): Promise<SentEmail> {
    const address = email.mailbox.emailAddress;
    let raw: string;
    try {
      raw = toBase64Url(buildMime(email));
    } catch (error) {
      throw new ProviderSendError(error instanceof Error ? error.message : "The message could not be built.", "definite");
    }
    let token: string;
    try {
      token = await this.token(address);
    } catch (error) {
      // No send was attempted, so this is safe to retry later.
      throw new ProviderSendError(error instanceof Error ? error.message : "Could not get a Google access token.", "definite");
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${API}/messages/send`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(email.threadId ? { raw, threadId: email.threadId } : { raw }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ProviderSendError(`The request to Gmail failed or timed out (${errorName(error)}). The message may have been sent.`, "unknown");
    }

    if (response.ok) {
      let body: { id?: unknown; threadId?: unknown } | null = null;
      try {
        body = (await response.json()) as { id?: unknown; threadId?: unknown };
      } catch {
        body = null;
      }
      if (!body || typeof body.id !== "string") {
        throw new ProviderSendError("Gmail accepted the request but the response could not be read. The message may have been sent.", "unknown");
      }
      return { providerMessageId: body.id, threadId: typeof body.threadId === "string" ? body.threadId : null };
    }

    const detail = await apiMessage(response);
    if (response.status === 401) this.tokens.delete(address);
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      throw new ProviderSendError(definiteMessage(response.status, address, detail), "definite");
    }
    throw new ProviderSendError(`Gmail answered ${response.status} (${detail}). The message may have been sent.`, "unknown");
  }

  /**
   * Gmail rewrites Message-ID when it accepts a message, so a search on our id never matches.
   * Every message carries our id in `X-MiaSDR-Send-Id`. Gmail cannot search that header, so this
   * lists sent mail since the claim (minus a 1 hour margin), newest first, and compares it.
   *
   * The list call sets `includeSpamTrash=true`: a message the owner or a cleanup rule moved to Trash
   * or Spam while the send was `unknown` still counts as sent. With `hint.to` the query adds
   * `to:<address>`, which shrinks the scan to that recipient's mail; without it the scan covers all
   * sent mail in the window under a page cap sized from the window length.
   *
   * `absent` needs three things: the listing ended because Gmail gave no next page token, no page cap
   * was hit, and the claim is at least 10 minutes old (Gmail's index can lag behind a send). A younger
   * claim that is not found is `inconclusive`. A claim older than 30 days is `inconclusive` without
   * a request. API errors throw.
   */
  async findSent(mailbox: { emailAddress: string }, rfcMessageId: string, since: Date, hint?: FindSentHint): Promise<FindSentResult> {
    const wanted = rfcMessageId.trim().replace(/^<|>$/g, "");
    const nowMs = this.now().getTime();
    const age = nowMs - since.getTime();
    if (!Number.isFinite(age)) return { status: "inconclusive", reason: "The claim time is not a valid date." };
    if (age > FIND_SENT_HORIZON_MS) {
      return { status: "inconclusive", reason: "The send was claimed more than 30 days ago, beyond what the sent-mail scan covers." };
    }
    const afterSeconds = Math.floor((since.getTime() - FIND_SENT_MARGIN_MS) / 1000);
    const to = hint?.to?.trim().toLowerCase();
    const recipient = to && SAFE_ADDRESS.test(to) ? to : null;
    const windowDays = (Math.max(age, 0) + FIND_SENT_MARGIN_MS) / 86_400_000;
    const maxPages = recipient ? HINTED_MAX_PAGES : Math.ceil((windowDays * SENT_PER_DAY_BOUND) / SCAN_PAGE_SIZE) + SCAN_PAGE_HEADROOM;
    const token = await this.token(mailbox.emailAddress);
    const auth = { authorization: `Bearer ${token}` };
    const fail = async (what: string, response: Response) => {
      if (response.status === 401) this.tokens.delete(mailbox.emailAddress);
      return new Error(`Gmail ${what} failed (${response.status}: ${await apiMessage(response)}).`);
    };
    const query = encodeURIComponent(`in:sent ${recipient ? `to:${recipient} ` : ""}after:${afterSeconds}`);
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const list = await this.fetchImpl(`${API}/messages?q=${query}&maxResults=${SCAN_PAGE_SIZE}&includeSpamTrash=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, {
        headers: auth,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!list.ok) throw await fail("search", list);
      const body = (await list.json()) as { messages?: Array<{ id?: string; threadId?: string }>; nextPageToken?: string };
      const ids = (body.messages ?? []).filter((m): m is { id: string; threadId?: string } => typeof m.id === "string");
      for (let i = 0; i < ids.length; i += DETAIL_CONCURRENCY) {
        const hits = await Promise.all(
          ids.slice(i, i + DETAIL_CONCURRENCY).map(async (m) => {
            const res = await this.fetchImpl(`${API}/messages/${m.id}?format=metadata&metadataHeaders=${SEND_ID_HEADER}`, {
              headers: auth,
              signal: AbortSignal.timeout(this.timeoutMs),
            });
            if (!res.ok) throw await fail("message lookup", res);
            const detail = (await res.json()) as { payload?: { headers?: Array<{ name?: string; value?: string }> } };
            const header = detail.payload?.headers?.find((h) => h.name?.toLowerCase() === SEND_ID_HEADER.toLowerCase());
            return header?.value?.trim().replace(/^<|>$/g, "") === wanted ? { providerMessageId: m.id, threadId: m.threadId ?? null } : null;
          }),
        );
        const found = hits.find((h) => h !== null);
        if (found) return { status: "found", sent: found };
      }
      if (!body.nextPageToken) {
        if (age < FIND_SENT_INDEX_LAG_MS) return { status: "inconclusive", reason: "The send was claimed less than 10 minutes ago and Gmail's search index may not hold it yet." };
        return { status: "absent" };
      }
      pageToken = body.nextPageToken;
    }
    return { status: "inconclusive", reason: `The sent-mail scan hit its cap of ${maxPages} pages before the listing ended.` };
  }

  /**
   * Inbox mail added since `cursor`, from the history API. History is read first and message bodies
   * second; any failure throws so the caller keeps its old cursor and retries the whole window.
   */
  async fetchInbound(mailbox: { emailAddress: string }, cursor: string | null): Promise<InboundBatch & { reset?: boolean }> {
    const address = mailbox.emailAddress;
    if (cursor === null) return { messages: [], cursor: await this.currentHistoryId(address) };

    const ids = new Set<string>();
    let newest = cursor;
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ startHistoryId: cursor, historyTypes: "messageAdded", labelId: "INBOX" });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await this.readGet(address, `${API}/history?${params}`, "history");
      if (response.status === 404) return { messages: [], cursor: await this.currentHistoryId(address), reset: true };
      const body = (await this.readJson(response, "history")) as {
        history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
        historyId?: string;
        nextPageToken?: string;
      };
      for (const record of body.history ?? []) {
        for (const added of record.messagesAdded ?? []) if (added.message?.id) ids.add(added.message.id);
      }
      if (body.historyId && isNewer(body.historyId, newest)) newest = String(body.historyId);
      pageToken = body.nextPageToken;
    } while (pageToken);

    const found = await mapLimit([...ids], DETAIL_CONCURRENCY, async (id): Promise<InboundEmail | null> => {
      const response = await this.readGet(address, `${API}/messages/${encodeURIComponent(id)}?format=full`, "message lookup");
      if (response.status === 404) return null;
      const message = (await this.readJson(response, "message lookup")) as GmailMessage;
      const labels = message.labelIds ?? [];
      if (!labels.includes("INBOX") || labels.includes("SENT") || labels.includes("DRAFT")) return null;
      return parseGmailMessage({ ...message, id: message.id ?? id });
    });
    return { messages: found.filter((m): m is InboundEmail => m !== null), cursor: newest };
  }

  /** Messages by id, for a retry. Unlike the history path this does not insist on the INBOX label, because a person may have archived the message since. */
  async fetchMessages(mailbox: { emailAddress: string }, providerMessageIds: string[]): Promise<{ messages: InboundEmail[]; missing: string[] }> {
    const address = mailbox.emailAddress;
    const found = await mapLimit(providerMessageIds, DETAIL_CONCURRENCY, async (id): Promise<InboundEmail | null> => {
      // Gmail answers 404 for a deleted message and 400 "Invalid id value" for an id it cannot resolve; both mean it is gone.
      const response = await this.readGet(address, `${API}/messages/${encodeURIComponent(id)}?format=full`, "message lookup", [404, 400]);
      if (response.status === 404 || response.status === 400) return null;
      const message = (await this.readJson(response, "message lookup")) as GmailMessage;
      const labels = message.labelIds ?? [];
      if (labels.includes("SENT") || labels.includes("DRAFT")) return null;
      return parseGmailMessage({ ...message, id: message.id ?? id });
    });
    const messages = found.filter((m): m is InboundEmail => m !== null);
    const have = new Set(messages.map((m) => m.providerMessageId));
    return { messages, missing: providerMessageIds.filter((id) => !have.has(id)) };
  }

  private async currentHistoryId(address: string): Promise<string> {
    const response = await this.readGet(address, `${API}/profile`, "profile lookup");
    const body = (await this.readJson(response, "profile lookup")) as { historyId?: unknown };
    if (body.historyId === undefined || body.historyId === null || body.historyId === "") throw new Error("Gmail profile lookup answered without a historyId.");
    return String(body.historyId);
  }

  /** GET for the read-only inbound path. A 404 (and any status in `tolerate`) is returned to the caller; any other failure throws. */
  private async readGet(address: string, url: string, what: string, tolerate: number[] = [404]): Promise<Response> {
    const token = await this.token(address);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new Error(`Could not reach the Gmail API for the ${what} (${errorName(error)}). Check the server's network access; the sync will retry.`);
    }
    if (response.ok || tolerate.includes(response.status)) return response;
    if (response.status === 401) this.tokens.delete(address);
    const hint = response.status === 401 || response.status === 403 ? ` ${DELEGATION_HINT}` : "";
    throw new Error(`Gmail ${what} failed for ${address} (${response.status}: ${await apiMessage(response)}).${hint}`);
  }

  private async readJson(response: Response, what: string): Promise<unknown> {
    if (!response.ok) throw new Error(`Gmail ${what} failed (${response.status}: ${await apiMessage(response)}).`);
    try {
      return await response.json();
    } catch {
      throw new Error(`Gmail ${what} answered with a body that could not be read.`);
    }
  }

  /** Access token for one impersonated mailbox. Concurrent callers share one exchange. */
  private token(emailAddress: string): Promise<string> {
    const cached = this.tokens.get(emailAddress);
    if (cached && this.now().getTime() < cached.expiresAt - EXPIRY_MARGIN_MS) return Promise.resolve(cached.value);
    const inflight = this.pending.get(emailAddress);
    if (inflight) return inflight;
    const exchange = this.exchange(emailAddress).finally(() => this.pending.delete(emailAddress));
    this.pending.set(emailAddress, exchange);
    return exchange;
  }

  private async exchange(emailAddress: string): Promise<string> {
    const assertion = this.signJwt(emailAddress);
    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new TokenError("Could not reach Google to get an access token. Check the server's network access and try again.");
    }
    if (!response.ok) {
      let code = "";
      let description = "";
      try {
        const body = (await response.json()) as { error?: unknown; error_description?: unknown };
        code = typeof body.error === "string" ? body.error : "";
        description = typeof body.error_description === "string" ? body.error_description : "";
      } catch {
        // Keep the status alone.
      }
      const label = [code, description].filter(Boolean).join(": ") || `HTTP ${response.status}`;
      const hint =
        code === "invalid_grant" || code === "unauthorized_client"
          ? ` ${DELEGATION_HINT}`
          : " The service account key may be wrong, disabled or deleted.";
      throw new TokenError(`Google would not give an access token for ${emailAddress} (${label}).${hint}`);
    }
    const body = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (!body || typeof body.access_token !== "string") throw new TokenError("Google answered the token request without an access token.");
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
    this.tokens.set(emailAddress, { value: body.access_token, expiresAt: this.now().getTime() + seconds * 1000 });
    return body.access_token;
  }

  private signJwt(emailAddress: string): string {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: this.credentials.clientEmail,
      sub: emailAddress,
      scope: SCOPES.join(" "),
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    };
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${part(header)}.${part(claims)}`;
    try {
      const signature = createSign("RSA-SHA256").update(unsigned).sign(this.credentials.privateKey).toString("base64url");
      return `${unsigned}.${signature}`;
    } catch {
      throw new TokenError("The service account private key could not be used to sign. Check that GOOGLE_SERVICE_ACCOUNT_JSON or the key file is the full, unmodified key.");
    }
  }
}

/** History ids are numeric strings that can exceed 2^53, so compare as BigInt. */
function isNewer(candidate: string, current: string): boolean {
  try {
    return BigInt(candidate) > BigInt(current);
  } catch {
    return false;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. Keeps input order and rejects on the first failure. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "error";
}

/** Google's own error text, shortened. Contains no credentials. */
async function apiMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } | string; error_description?: string };
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    return (message ?? body.error_description ?? `HTTP ${response.status}`).slice(0, 300);
  } catch {
    return `HTTP ${response.status}`;
  }
}

function definiteMessage(status: number, address: string, detail: string): string {
  if (status === 401 || status === 403) {
    return `Gmail refused to send as ${address} (${status}: ${detail}). ${DELEGATION_HINT}`;
  }
  if (status === 404) return `Gmail could not find the mailbox ${address} (404: ${detail}). Check that the address is a user in your Workspace domain.`;
  return `Gmail rejected the message (${status}: ${detail}).`;
}
