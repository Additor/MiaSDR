import { linkedinSlug } from "../domain/linkedin";
import { parseLinkedInProfileRef, PROVIDER_ID } from "../domain/linkedin-identity";
import {
  LinkedInGatewayError,
  type GatewayAccount,
  type HostedAuthLinkInput,
  type GatewayErrorCode,
  type GatewayProfile,
  type LinkedInGateway,
  type NetworkDistance,
  type SearchPage,
  type WebhookRegistration,
} from "../application/linkedin-ports";

/*
 * Unipile adapter over fetch, no SDK. Every call below was checked against the official reference
 * (developer.unipile.com/reference/..., read 2026-10-14). Nothing here has run against a real account yet.
 *
 * Common to all calls (docs "Send an invitation" page, Authorization section):
 *   base URL  https://{subdomain}.unipile.com:{port}  (the DSN shown in the dashboard, default api1 and 13111)
 *   header    X-API-KEY: <access token>
 *   errors    JSON { title, type, status, detail? }, for example type "errors/cannot_resend_yet".
 */

export interface UnipileOptions {
  /** The already-normalized host (from `parseDsn`). The gateway does not parse or validate it. */
  dsn: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Scheme decided by `parseDsn`: `http` only for a loopback host the policy allowed. Defaults to https, so a stored DSN never downgrades. */
  scheme?: "https" | "http";
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

const DISTANCE: Record<string, NetworkDistance> = {
  FIRST_DEGREE: "first",
  SECOND_DEGREE: "second",
  THIRD_DEGREE: "third",
  OUT_OF_NETWORK: "out_of_network",
  DISTANCE_1: "first",
  DISTANCE_2: "second",
  DISTANCE_3: "third",
};

/** Maps an HTTP answer to the outcome discipline. A response the provider wrote is a refusal (definite) unless it is a 5xx. */
export function classifyHttpError(status: number, body: Json | null): LinkedInGatewayError {
  const type = str(body?.type) ?? "";
  const detail = str(body?.detail) ?? str(body?.title) ?? `HTTP ${status}`;
  const text = `Unipile: ${detail}`;
  const definite = (code: GatewayErrorCode) => new LinkedInGatewayError(text, "definite", code);

  if (status >= 500) return new LinkedInGatewayError(text, "unknown", "unavailable");
  // Live check 2026-10-15: a lookup with linkedin_api on a classic-only account answers 401 type errors/insufficient_privileges
  // ("This resource seems to be out of your scopes."). The credentials work, so this is not `auth`.
  if ((status === 401 || status === 403) && type.includes("insufficient_privileges")) {
    return new LinkedInGatewayError(`Unipile refused the call because this LinkedIn account lacks access to the resource (${detail}).`, "definite", "insufficient_privileges");
  }
  if (status === 401) return definite("auth");
  if (status === 429) return definite("rate_limited");
  if (status === 404) return definite("not_found");
  if (status === 403) return definite(type.includes("credentials") ? "auth" : "rejected");
  if (status === 422) {
    // Types listed under 422 on the "Send an invitation" reference.
    if (/cannot_resend_yet|limit_exceeded|connection_limit_reached|too_many/.test(type)) return definite("rate_limited");
    if (/already_invited/.test(type)) return definite("already_invited");
    if (/already_connected/.test(type)) return definite("already_connected");
    if (/cannot_invite_attendee|invalid_recipient/.test(type)) return definite("invalid_recipient");
    if (/first degree|first-degree|not.*relation/i.test(detail)) return definite("not_first_degree");
    return definite("rejected");
  }
  return definite("rejected");
}

export class UnipileGateway implements LinkedInGateway {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: UnipileOptions) {
    // Host and scheme come from the DSN policy (`parseDsn`). Unipile is https unless the policy allowed a loopback stand-in.
    this.base = `${options.scheme ?? "https"}://${options.dsn}`;
    this.doFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async call(method: string, path: string, init: { query?: Record<string, string | number | undefined>; json?: unknown; form?: FormData } = {}): Promise<Json> {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { "X-API-KEY": this.options.apiKey, accept: "application/json" };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form;
    }
    let response: Response;
    try {
      response = await this.doFetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      // No answer: the request may or may not have been processed.
      throw new LinkedInGatewayError(`Could not reach Unipile: ${error instanceof Error ? error.message : String(error)}`, "unknown", "unavailable");
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The answer broke off or the timeout hit while reading it: the action may have happened.
      throw new LinkedInGatewayError(`Could not read the Unipile answer: ${error instanceof Error ? error.message : String(error)}`, "unknown", "unavailable");
    }
    let parsed: Json | null = null;
    try {
      parsed = text === "" ? null : (JSON.parse(text) as Json);
    } catch {
      parsed = null;
      // A success status with a body that is not JSON (a proxy page, a cut-off answer) says nothing about what happened.
      if (response.ok) throw new LinkedInGatewayError(`Unipile answered ${response.status} with a body that is not JSON.`, "unknown", "unavailable");
    }
    if (!response.ok) throw classifyHttpError(response.status, parsed);
    return parsed ?? {};
  }

  /** Docs "List all accounts": GET /api/v1/accounts, query limit (1 to 250) and cursor. Used with limit=1 as the credential check. */
  async verify(): Promise<void> {
    await this.call("GET", "/api/v1/accounts", { query: { limit: 1 } });
  }

  async listAccounts(): Promise<GatewayAccount[]> {
    const out: GatewayAccount[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.call("GET", "/api/v1/accounts", { query: { limit: 100, cursor } });
      for (const item of (res.items as Json[] | undefined) ?? []) {
        if (item.type !== "LINKEDIN") continue;
        const im = ((item.connection_params as Json | undefined)?.im ?? {}) as Json;
        const sources = (item.sources as Json[] | undefined) ?? [];
        out.push({
          ref: String(item.id),
          linkedinId: str(im.id),
          name: str(item.name),
          username: str(im.username) ?? str(im.publicIdentifier),
          status: sources[0]?.status === "OK" ? "connected" : "disconnected",
        });
      }
      cursor = str(res.cursor) ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** Docs "Retrieve own profile": GET /api/v1/users/me?account_id=. The premium flag is named `premium` there. */
  async getOwnProfile(account: string): Promise<GatewayProfile> {
    return this.toProfile(await this.call("GET", "/api/v1/users/me", { query: { account_id: account } }));
  }

  /** Docs "Retrieve a profile": GET /api/v1/users/{identifier}?account_id=. Classic accepts the public id (slug) or the provider id.
   * `linkedinApi` is sent only as a fallback for a Sales Navigator or Recruiter member id. Live check 2026-10-15: an account without those scopes
   * answers it with 401 errors/insufficient_privileges (code insufficient_privileges), so callers try the lookup without it first. */
  async getProfile(input: { account: string; identifier: string; linkedinApi?: "sales_navigator" | "recruiter" }): Promise<GatewayProfile> {
    // A member id is case sensitive: a provider id (ACo..., ACw..., AE...), anything read as a member reference,
    // and any id sent with a linkedin_api. Only a slug is lowercased.
    const keepCase = input.linkedinApi !== undefined || PROVIDER_ID.test(input.identifier) || parseLinkedInProfileRef(input.identifier)?.kind === "member";
    const identifier = keepCase ? input.identifier : (linkedinSlug(input.identifier) ?? input.identifier);
    return this.toProfile(await this.call("GET", `/api/v1/users/${encodeURIComponent(identifier)}`, { query: { account_id: input.account, ...(input.linkedinApi ? { linkedin_api: input.linkedinApi } : {}) } }));
  }

  private toProfile(res: Json): GatewayProfile {
    const member = str(res.provider_id);
    if (!member) throw new LinkedInGatewayError("Unipile returned a profile without provider_id.", "definite", "not_found");
    return {
      member,
      publicSlug: str(res.public_identifier),
      firstName: str(res.first_name),
      lastName: str(res.last_name),
      headline: str(res.headline),
      location: str(res.location),
      pictureUrl: str(res.profile_picture_url),
      networkDistance: DISTANCE[String(res.network_distance)] ?? "unknown",
      isPremium: res.premium === true || res.is_premium === true,
    };
  }

  /** Docs "Send an invitation": POST /api/v1/users/invite, JSON { provider_id, account_id, message? (max 300) }, 200 { invitation_id }. */
  async sendInvitation(input: { account: string; member: string; note: string | null }): Promise<{ invitationId: string | null }> {
    const res = await this.call("POST", "/api/v1/users/invite", {
      json: { provider_id: input.member, account_id: input.account, ...(input.note ? { message: input.note } : {}) },
    });
    return { invitationId: str(res.invitation_id) };
  }

  /**
   * Docs "List all invitations sent": GET /api/v1/users/invite/sent, query account_id, cursor, limit (1 to 100).
   * Items carry invited_user_id. An accepted invitation leaves that list, so a miss falls back to the profile's network_distance.
   */
  async invitationStatus(input: { account: string; member: string }): Promise<"pending" | "accepted" | "none"> {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await this.call("GET", "/api/v1/users/invite/sent", { query: { account_id: input.account, limit: 100, cursor } });
      if (((res.items as Json[] | undefined) ?? []).some((i) => i.invited_user_id === input.member)) return "pending";
      cursor = str(res.cursor) ?? undefined;
      if (!cursor) break;
    }
    const profile = await this.getProfile({ account: input.account, identifier: input.member });
    return profile.networkDistance === "first" ? "accepted" : "none";
  }

  /** Docs "List all 1to1 chats for a given attendee": GET /api/v1/chat_attendees/{attendee_id}/chats?account_id=&limit=. */
  async findChat(input: { account: string; member: string }): Promise<string | null> {
    const res = await this.call("GET", `/api/v1/chat_attendees/${encodeURIComponent(input.member)}/chats`, { query: { account_id: input.account, limit: 1 } });
    return str(((res.items as Json[] | undefined) ?? [])[0]?.id);
  }

  /** Docs "Send a message in a chat": POST /api/v1/chats/{chat_id}/messages, multipart text and account_id, 201 { message_id }. */
  async sendMessage(input: { account: string; chat: string; text: string }): Promise<{ messageId: string | null }> {
    const form = new FormData();
    form.set("text", input.text);
    form.set("account_id", input.account);
    const res = await this.call("POST", `/api/v1/chats/${encodeURIComponent(input.chat)}/messages`, { form });
    return { messageId: str(res.message_id) };
  }

  /** Docs "Start a new chat": POST /api/v1/chats, multipart account_id, attendees_ids, text, 201 { chat_id, message_id }. LinkedIn needs a first-degree relation. */
  async startChat(input: { account: string; member: string; text: string }): Promise<{ chat: string | null; messageId: string | null }> {
    const form = new FormData();
    form.set("account_id", input.account);
    form.append("attendees_ids", input.member);
    form.set("text", input.text);
    const res = await this.call("POST", "/api/v1/chats", { form });
    return { chat: str(res.chat_id), messageId: str(res.message_id) };
  }

  /** Docs "List all messages from a chat": GET /api/v1/chats/{chat_id}/messages, query after (ISO), limit; items have is_sender (0 or 1) and text. */
  async findSentMessage(input: { account: string; chat: string; text: string; since: Date }): Promise<{ messageId: string | null } | null> {
    const res = await this.call("GET", `/api/v1/chats/${encodeURIComponent(input.chat)}/messages`, { query: { after: input.since.toISOString(), limit: 50 } });
    const wanted = input.text.trim();
    const hit = ((res.items as Json[] | undefined) ?? []).find((m) => Number(m.is_sender) === 1 && typeof m.text === "string" && m.text.trim() === wanted);
    return hit ? { messageId: str(hit.id) } : null;
  }

  /**
   * Docs "LinkedIn search" guide: POST /api/v1/linkedin/search?account_id=, JSON { url } with a copied classic or Sales Navigator URL.
   * Response { items, cursor, paging: { total_count } }. The reference lists `cursor` as a query parameter, which this sends.
   */
  async searchPeople(input: { account: string; searchUrl: string; cursor: string | null }): Promise<SearchPage> {
    const res = await this.call("POST", "/api/v1/linkedin/search", {
      query: { account_id: input.account, cursor: input.cursor ?? undefined },
      json: { url: input.searchUrl },
    });
    const items = ((res.items as Json[] | undefined) ?? []).filter((i) => i.type === undefined || i.type === "PEOPLE");
    return {
      items: items.map((i) => ({
        identifier: str(i.public_identifier) ?? str(i.public_profile_url) ?? str(i.profile_url) ?? String(i.id),
        profileUrl: str(i.public_profile_url) ?? str(i.profile_url),
        name: str(i.name),
        headline: str(i.headline),
        location: str(i.location),
        networkDistance: str(i.network_distance),
        raw: i,
      })),
      nextCursor: str(res.cursor),
      totalEstimate: typeof (res.paging as Json | undefined)?.total_count === "number" ? ((res.paging as Json).total_count as number) : null,
    };
  }

  /**
   * Docs "Create a webhook": POST /api/v1/webhooks JSON { source, request_url, name, events, headers[{key,value}], format }.
   * source "users" allows only event new_relation, source "messaging" allows message_received (and others). Returns 201 { webhook_id }.
   * Docs "List all webhooks" (GET /api/v1/webhooks, items with id and request_url) and "Delete a webhook" (DELETE /api/v1/webhooks/{id}).
   * Webhooks made through the API carry no JSON content type unless set in headers, and Unipile expects a 200 within 30 seconds.
   * Authentication is a custom header with a secret chosen by us (docs "Webhooks" overview).
   */
  async registerWebhooks(input: { requestUrl: string; secret: string; name: string }): Promise<WebhookRegistration> {
    // Same URL means an earlier registration of ours, possibly with an older secret.
    await this.removeWebhooks({ requestUrl: input.requestUrl });
    const headers = [
      { key: "Content-Type", value: "application/json" },
      { key: "x-unipile-secret", value: input.secret },
    ];
    const registered: string[] = [];
    const hooks: WebhookRegistration["hooks"] = [];
    for (const [source, events] of [
      ["users", ["new_relation"]],
      ["messaging", ["message_received"]],
    ] as const) {
      const name = `${source}:${events.join(",")}`;
      try {
        await this.call("POST", "/api/v1/webhooks", {
          json: { source, request_url: input.requestUrl, name: `${input.name} ${source}`, events, headers, format: "json" },
        });
        registered.push(name);
        hooks.push({ name, error: null });
      } catch (error) {
        // One failed hook does not stop the next, so the stored status shows which of them works.
        hooks.push({ name, error });
      }
    }
    return { registered, hooks };
  }

  /** Lists every page of webhooks and deletes those registered for `requestUrl`. */
  async removeWebhooks(input: { requestUrl: string }): Promise<{ removed: number }> {
    let removed = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.call("GET", "/api/v1/webhooks", { query: { limit: 100, cursor } });
      for (const hook of (res.items as Json[] | undefined) ?? []) {
        if (hook.request_url === input.requestUrl && typeof hook.id === "string") {
          await this.call("DELETE", `/api/v1/webhooks/${encodeURIComponent(hook.id)}`);
          removed += 1;
        }
      }
      cursor = str(res.cursor) ?? undefined;
      if (!cursor) break;
    }
    return { removed };
  }
  /**
   * Hosted auth: POST /api/v1/hosted/accounts/link, JSON { type: "create" | "reconnect", providers (create only), api_url, expiresOn (ISO 8601),
   * success_redirect_url, failure_redirect_url, notify_url?, name, reconnect_account (reconnect only) }, answer { url }.
   * The body fields follow the Unipile hosted-auth guide and the field names of the official Unipile SDK.
   * The reference page for this endpoint could not be read when this was written, so the path is unverified against a live account.
   * The notify callback carries { status: "CREATION_SUCCESS" | "RECONNECTED", account_id, name } and no signature, so the caller must hide a secret in `notify_url`.
   */
  async createHostedAuthLink(input: HostedAuthLinkInput): Promise<{ url: string }> {
    const shared = {
      api_url: this.base,
      expiresOn: input.expiresAt.toISOString(),
      name: input.name,
      success_redirect_url: input.successRedirectUrl,
      failure_redirect_url: input.failureRedirectUrl,
      ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
    };
    const res = await this.call("POST", "/api/v1/hosted/accounts/link", {
      json: input.reconnectAccount ? { type: "reconnect", reconnect_account: input.reconnectAccount, ...shared } : { type: "create", providers: ["LINKEDIN"], ...shared },
    });
    const url = str(res.url);
    // Nothing was created that the caller could use, and no account changed: a definite failure.
    if (!url) throw new LinkedInGatewayError("Unipile returned no hosted-auth URL.", "definite", "rejected");
    return { url };
  }
}
