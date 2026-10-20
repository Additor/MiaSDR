import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

/*
 * LOCAL STAND-IN for the Unipile API. This is NOT Unipile and NOT a verification against the real service.
 *
 * It implements the endpoints the MiaSDR adapter calls, with request rules and response shapes taken from the
 * official reference (developer.unipile.com/reference/..., read 2026-10-15). Where the reference has no example
 * body, the shape is built from the documented response schema with invented values. It exists so the real
 * UnipileGateway, engine, webhook route and stores can run end to end without an account.
 *
 * What it enforces: X-API-KEY (401), documented methods, content types (JSON or multipart, 415 otherwise),
 * required fields, query parameter names, ranges and cursors, the 300 character invitation note, and the
 * first-degree rule for new chats. It cannot show real rate limits, real payload quirks, real webhook
 * delivery timing or account connection flows.
 *
 * Only Node built-ins are imported, so a plain node process can run it too.
 */

export type FaultKind =
  /** 429 errors/too_many_requests. */
  | "rate_limit"
  /** 500 errors/provider_error. */
  | "server_error"
  /** 503 errors/service_unavailable. */
  | "unavailable"
  /** The connection stays open and never answers. */
  | "hang"
  /** 200 with a body that is not JSON. */
  | "malformed"
  /** Any status and body, for example a 422 with a documented error type. */
  | "status";

export interface Fault {
  kind: FaultKind;
  /** For kind "status". */
  status?: number;
  body?: unknown;
  /** How many requests the fault applies to. Default: all until cleared. */
  times?: number;
  /** Run the real effect first (create the invitation, store the message), then replace the answer. Models "timeout after accept". */
  applyEffect?: boolean;
}

export interface RecordedRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  /** The route template that matched, such as `GET /api/v1/users/:identifier`, or null when none did. */
  route: string | null;
  query: Record<string, string[]>;
  headers: Record<string, string>;
  contentType: string | null;
  json: unknown;
  /** Multipart fields. Repeated fields keep every value. */
  form: Record<string, string[]> | null;
  status: number;
  /** The fault that shaped the answer, if any. */
  fault: FaultKind | null;
}

export interface StandinProfile {
  providerId: string;
  publicIdentifier: string;
  firstName: string;
  lastName: string;
  headline?: string;
  location?: string;
  distance?: "FIRST_DEGREE" | "SECOND_DEGREE" | "THIRD_DEGREE" | "OUT_OF_NETWORK";
  premium?: boolean;
}

export interface StandinAccount {
  id: string;
  type: "LINKEDIN" | "GOOGLE_OAUTH";
  name: string;
  /** LinkedIn member id of the owner (connection_params.im.id). */
  memberId: string;
  username: string;
  publicIdentifier: string;
  status: "OK" | "ERROR";
  premium: boolean;
}

interface Invitation {
  id: string;
  account: string;
  invitedUserId: string;
  publicId: string;
  text: string | null;
  at: Date;
}

interface Message {
  id: string;
  chatId: string;
  senderId: string;
  isSender: boolean;
  text: string;
  at: Date;
}

interface Chat {
  id: string;
  account: string;
  attendee: string;
  at: Date;
}

interface Webhook {
  id: string;
  source: string;
  requestUrl: string;
  name: string;
  events: string[];
  headers: Array<{ key: string; value: string }>;
  format: string;
  enabled: boolean;
}

export interface StandinOptions {
  /** Default "test-api-key". */
  apiKey?: string;
  /** Port to listen on. Default 0 (any free port). */
  port?: number;
  /** Largest page any list answers with, whatever `limit` asks. Lets tests exercise cursor paging with few items. */
  pageCap?: number;
  /** When true, a message sent through the API also produces the `message_received` echo Unipile sends for the owner's own messages. */
  echoOwnMessages?: boolean;
  /** Replaces the URL a webhook is delivered to (for example to reach a route handler in-process). */
  rewriteWebhookUrl?: (url: string) => string;
  /** Replaces fetch for webhook delivery (for example to call a route handler directly). */
  deliver?: (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<Response>;
  /** Clock for timestamps of messages, chats and invitations. Default: the real clock. */
  now?: () => Date;
  /** Log a line per request to stderr. */
  log?: boolean;
}

type Json = Record<string, unknown>;
interface Result {
  status: number;
  body: unknown;
}
interface Ctx {
  method: string;
  path: string;
  query: URLSearchParams;
  json: Json;
  form: FormData | null;
  params: Record<string, string>;
}
interface Route {
  method: string;
  template: string;
  regex: RegExp;
  names: string[];
  query: { allowed: string[]; required?: string[] };
  body: "none" | "json" | "multipart";
  handle: (ctx: Ctx) => Result;
}

const TITLES: Record<string, string> = {
  "errors/invalid_credentials": "Invalid credentials",
  "errors/missing_credentials": "Missing credentials",
  "errors/invalid_parameters": "Invalid parameters",
  "errors/missing_parameters": "Missing parameters",
  "errors/malformed_request": "Malformed request",
  "errors/too_many_characters": "Too many characters",
  "errors/invalid_url": "Invalid URL",
  "errors/resource_not_found": "Resource not found",
  "errors/unsupported_media_type": "Unsupported media type",
  "errors/too_many_requests": "Too many requests",
  "errors/provider_error": "Provider error",
  "errors/service_unavailable": "Service unavailable",
};

function fail(status: number, type: string, detail?: string): Result {
  return { status, body: { title: TITLES[type] ?? type, type, status, ...(detail ? { detail } : {}) } };
}

const ok = (body: unknown, status = 200): Result => ({ status, body });
const is = (v: unknown): v is string => typeof v === "string" && v !== "";

function compile(method: string, template: string, query: Route["query"], body: Route["body"], handle: Route["handle"]): Route {
  const names: string[] = [];
  const pattern = template.replace(/:([a-z_]+)/g, (_m, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { method, template: `${method} ${template}`, regex: new RegExp(`^${pattern}$`), names, query, body, handle };
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
function decodeCursor(cursor: string | null): number | null {
  if (cursor === null) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown };
    return typeof value.o === "number" && Number.isInteger(value.o) && value.o >= 0 ? value.o : null;
  } catch {
    return null;
  }
}

const iso = (d: Date) => d.toISOString();

export class UnipileStandin {
  readonly apiKey: string;
  readonly requests: RecordedRequest[] = [];
  readonly accounts: StandinAccount[] = [];
  readonly profiles: StandinProfile[] = [];
  readonly invitations: Invitation[] = [];
  readonly chats: Chat[] = [];
  readonly messages: Message[] = [];
  readonly webhooks: Webhook[] = [];
  /** People the classic search returns, in order. */
  searchResults: Array<{ providerId: string; name: string; headline?: string; location?: string; distance?: string }> = [];
  /** Webhook deliveries made by the stand-in, with the answer the receiver gave. */
  readonly deliveries: Array<{ url: string; event: unknown; status: number | null }> = [];
  options: StandinOptions;

  private readonly faults = new Map<string, Fault & { used: number }>();
  private readonly routes: Route[];
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly hung = new Set<ServerResponse>();
  private counter = 0;
  private port = 0;

  constructor(options: StandinOptions = {}) {
    this.options = options;
    this.apiKey = options.apiKey ?? "test-api-key";
    this.routes = this.buildRoutes();
  }

  /** Host and port as shown in the Unipile dashboard (the DSN), for example `127.0.0.1:41234`. */
  get dsn(): string {
    return `127.0.0.1:${this.port}`;
  }
  get url(): string {
    return `http://${this.dsn}`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.onRequest(req, res));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server!.listen(this.options.port ?? 0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }

  async close(): Promise<void> {
    for (const res of this.hung) res.destroy();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  // ---- Test controls ----

  /** Faults are keyed by route template, for example `POST /api/v1/users/invite` or `GET /api/v1/users/:identifier`. */
  setFault(route: string, fault: Fault): void {
    this.faults.set(route, { ...fault, used: 0 });
  }
  clearFaults(): void {
    this.faults.clear();
  }
  clearRequests(): void {
    this.requests.length = 0;
  }
  /** Requests recorded for a route template (or every request when omitted). */
  calls(route?: string): RecordedRequest[] {
    return route ? this.requests.filter((r) => r.route === route) : [...this.requests];
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}${Math.random().toString(36).slice(2, 8)}${this.counter}`;
  }

  addAccount(partial: Partial<StandinAccount> = {}): StandinAccount {
    const n = this.accounts.length + 1;
    const account: StandinAccount = {
      id: partial.id ?? this.nextId("acct"),
      type: partial.type ?? "LINKEDIN",
      name: partial.name ?? `Seller ${n}`,
      memberId: partial.memberId ?? `ACoOwner${n}x`,
      username: partial.username ?? `seller${n}@example.com`,
      publicIdentifier: partial.publicIdentifier ?? `seller-${n}`,
      status: partial.status ?? "OK",
      premium: partial.premium ?? false,
    };
    this.accounts.push(account);
    return account;
  }

  addProfile(partial: Partial<StandinProfile> & { publicIdentifier: string }): StandinProfile {
    const profile: StandinProfile = {
      providerId: partial.providerId ?? `ACo${partial.publicIdentifier.replace(/[^a-z0-9]/gi, "")}`,
      firstName: partial.firstName ?? "Jane",
      lastName: partial.lastName ?? "Doe",
      headline: partial.headline ?? "Senior Engineer at Example Corp",
      location: partial.location ?? "Springfield, Illinois, United States",
      distance: partial.distance ?? "SECOND_DEGREE",
      premium: partial.premium ?? false,
      publicIdentifier: partial.publicIdentifier,
    };
    this.profiles.push(profile);
    return profile;
  }

  private profileBy(identifier: string): StandinProfile | undefined {
    return this.profiles.find((p) => p.providerId === identifier || p.publicIdentifier === identifier);
  }

  /** The person accepts: the invitation leaves the sent list and the member becomes first degree. Returns the `new_relation` payload. */
  accept(accountId: string, providerId: string): Json {
    const index = this.invitations.findIndex((i) => i.account === accountId && i.invitedUserId === providerId);
    if (index >= 0) this.invitations.splice(index, 1);
    const profile = this.profileBy(providerId);
    if (profile) profile.distance = "FIRST_DEGREE";
    return {
      event: "new_relation",
      account_id: accountId,
      account_type: "LINKEDIN",
      webhook_name: "standin",
      user_full_name: profile ? `${profile.firstName} ${profile.lastName}` : "Unknown",
      user_provider_id: providerId,
      user_public_identifier: profile?.publicIdentifier ?? "",
      user_profile_url: profile ? `https://www.linkedin.com/in/${profile.publicIdentifier}` : "",
      user_picture_url: "https://media.example.com/profile.jpg",
    };
  }

  /** The person writes. Creates the chat when none exists and returns the `message_received` payload. */
  reply(accountId: string, providerId: string, text: string): Json {
    const chat = this.chatFor(accountId, providerId) ?? this.createChat(accountId, providerId);
    const message = this.addMessage(chat, providerId, false, text);
    return this.messagePayload(chat, message);
  }

  private chatFor(account: string, attendee: string): Chat | undefined {
    return this.chats.find((c) => c.account === account && c.attendee === attendee);
  }

  private createChat(account: string, attendee: string): Chat {
    const chat: Chat = { id: this.nextId("chat"), account, attendee, at: this.now() };
    this.chats.push(chat);
    return chat;
  }

  private addMessage(chat: Chat, senderId: string, isSender: boolean, text: string): Message {
    const message: Message = { id: this.nextId("msg"), chatId: chat.id, senderId, isSender, text, at: this.now() };
    this.messages.push(message);
    return message;
  }

  /** `message_received` body. There is no is_sender field; the owner's id in account_info.user_id marks an echo. */
  private messagePayload(chat: Chat, message: Message): Json {
    const account = this.accounts.find((a) => a.id === chat.account);
    const owner = account?.memberId ?? "";
    const other = this.profileBy(chat.attendee);
    const attendee = (id: string, name: string, slug: string) => ({
      attendee_id: `att-${id}`,
      attendee_name: name,
      attendee_provider_id: id,
      attendee_profile_url: `https://www.linkedin.com/in/${slug}`,
    });
    const ownerAttendee = attendee(owner, account?.name ?? "Owner", account?.publicIdentifier ?? "owner");
    const otherAttendee = attendee(chat.attendee, other ? `${other.firstName} ${other.lastName}` : "Unknown", other?.publicIdentifier ?? "unknown");
    return {
      event: "message_received",
      account_id: chat.account,
      account_type: "LINKEDIN",
      webhook_name: "standin",
      account_info: { type: "LINKEDIN", feature: "classic", user_id: owner },
      chat_id: chat.id,
      message_id: message.id,
      message: message.text,
      sender: message.isSender ? ownerAttendee : otherAttendee,
      attendees: [ownerAttendee, otherAttendee],
      attachments: [],
      timestamp: iso(message.at),
    };
  }

  /** Sends one event to every enabled webhook registered for it, with the headers it was registered with. */
  async deliverWebhook(payload: Json): Promise<Array<{ url: string; status: number | null }>> {
    const source = payload.event === "new_relation" ? "users" : "messaging";
    const out: Array<{ url: string; status: number | null }> = [];
    for (const hook of this.webhooks) {
      if (!hook.enabled || hook.source !== source || !hook.events.includes(String(payload.event))) continue;
      const url = this.options.rewriteWebhookUrl ? this.options.rewriteWebhookUrl(hook.requestUrl) : hook.requestUrl;
      const headers: Record<string, string> = {};
      for (const h of hook.headers) headers[h.key] = h.value;
      const body = JSON.stringify({ ...payload, webhook_name: hook.name });
      let status: number | null = null;
      try {
        const init = { method: "POST" as const, headers, body };
        const response = this.options.deliver ? await this.options.deliver(url, init) : await fetch(url, init);
        status = response.status;
      } catch {
        status = null;
      }
      this.deliveries.push({ url, event: payload, status });
      out.push({ url, status });
    }
    return out;
  }

  // ---- HTTP ----

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://standin");
    const method = req.method ?? "GET";
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);

    if (url.pathname.startsWith("/__standin/")) return this.control(method, url, raw, res);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
    const contentType = headers["content-type"] ?? null;
    const query: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams) (query[k] ??= []).push(v);
    const record: RecordedRequest = { method, path: url.pathname, route: null, query, headers, contentType, json: undefined, form: null, status: 0, fault: null };
    this.requests.push(record);

    const finish = (result: Result | "hang" | "malformed", fault: FaultKind | null) => {
      record.fault = fault;
      if (result === "hang") {
        record.status = 0;
        this.hung.add(res);
        return;
      }
      if (result === "malformed") {
        record.status = 200;
        res.writeHead(200, { "content-type": "application/json" }).end('{"object": "AccountList", "items": [');
        return;
      }
      record.status = result.status;
      res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
      if (this.options.log) process.stderr.write(`[standin] ${method} ${url.pathname}${url.search} -> ${result.status}\n`);
    };

    // Docs: every call carries X-API-KEY.
    const key = headers["x-api-key"];
    if (!key) return finish(fail(401, "errors/missing_credentials"), null);
    if (key !== this.apiKey) return finish(fail(401, "errors/invalid_credentials"), null);

    const matches = this.routes.filter((r) => r.regex.test(url.pathname));
    // Static segments beat parameters: `/users/invite/sent` is not a user identifier.
    const route = matches.find((r) => r.method === method && !r.names.length) ?? matches.find((r) => r.method === method);
    if (!route) {
      return finish(matches.length ? fail(405, "errors/method_not_allowed", `${method} is not allowed on ${url.pathname}`) : fail(404, "errors/resource_not_found", `No route ${url.pathname}`), null);
    }
    record.route = route.template;
    const params: Record<string, string> = {};
    const m = route.regex.exec(url.pathname)!;
    route.names.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));

    const ctx: Ctx = { method, path: url.pathname, query: url.searchParams, json: {}, form: null, params };
    const problem = await this.parseInput(route, ctx, raw, contentType, record);
    if (problem) return finish(problem, null);

    const fault = this.faults.get(route.template);
    const active = fault && (fault.times === undefined || fault.used < fault.times) ? fault : null;
    if (active) active.used += 1;
    // Without applyEffect the fault replaces the request; with it the effect happens and only the answer is lost.
    const result = !active || active.applyEffect ? this.safeHandle(route, ctx) : null;
    if (!active) return finish(result!, null);

    switch (active.kind) {
      case "hang":
        return finish("hang", "hang");
      case "malformed":
        return finish("malformed", "malformed");
      case "rate_limit":
        return finish({ status: 429, body: { title: TITLES["errors/too_many_requests"], type: "errors/too_many_requests", status: 429, retry_after: 60 } }, "rate_limit");
      case "server_error":
        return finish(fail(500, "errors/provider_error", "The provider is experiencing operational problems."), "server_error");
      case "unavailable":
        return finish(fail(503, "errors/service_unavailable"), "unavailable");
      case "status":
        return finish({ status: active.status ?? 500, body: active.body ?? { title: "Fault", type: "errors/unexpected_error", status: active.status ?? 500 } }, "status");
    }
  }

  /** Runs a handler and turns a thrown error into a 500. */
  private safeHandle(route: Route, ctx: Ctx): Result {
    try {
      return route.handle(ctx);
    } catch (error) {
      return fail(500, "errors/unexpected_error", error instanceof Error ? error.message : String(error));
    }
  }

  private async parseInput(route: Route, ctx: Ctx, raw: Buffer, contentType: string | null, record: RecordedRequest): Promise<Result | null> {
    for (const name of new Set(ctx.query.keys())) {
      if (!route.query.allowed.includes(name)) return fail(400, "errors/invalid_parameters", `Unknown query parameter ${name}`);
    }
    for (const name of route.query.required ?? []) {
      if (!ctx.query.get(name)) return fail(400, "errors/missing_parameters", `Missing query parameter ${name}`);
    }
    for (const name of ["cursor", "after", "before", "account_id", "sender_id"]) {
      if (ctx.query.has(name) && ctx.query.get(name) === "") return fail(400, "errors/invalid_parameters", `${name} must not be empty`);
    }
    if (route.body === "json") {
      if (!contentType?.toLowerCase().startsWith("application/json")) return fail(415, "errors/unsupported_media_type", "Expected application/json");
      try {
        const parsed: unknown = JSON.parse(raw.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "errors/malformed_request", "Body must be an object");
        ctx.json = parsed as Json;
        record.json = parsed;
      } catch {
        return fail(400, "errors/malformed_request", "Body is not valid JSON");
      }
    } else if (route.body === "multipart") {
      if (!contentType?.toLowerCase().startsWith("multipart/form-data")) return fail(415, "errors/unsupported_media_type", "Expected multipart/form-data");
      try {
        const form = await new Request("http://standin/", { method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(raw) }).formData();
        ctx.form = form;
        const fields: Record<string, string[]> = {};
        for (const [k, v] of form.entries()) (fields[k] ??= []).push(typeof v === "string" ? v : `[file ${v.name}]`);
        record.form = fields;
      } catch {
        return fail(400, "errors/malformed_request", "Body is not valid multipart/form-data");
      }
    }
    return null;
  }

  private control(method: string, url: URL, raw: Buffer, res: ServerResponse): void {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const body = (): Json => {
      try {
        return raw.length ? (JSON.parse(raw.toString("utf8")) as Json) : {};
      } catch {
        return {};
      }
    };
    const action = url.pathname.replace("/__standin/", "");
    if (method === "GET" && action === "state") {
      return send(200, {
        accounts: this.accounts,
        invitations: this.invitations,
        chats: this.chats,
        messages: this.messages,
        webhooks: this.webhooks,
        deliveries: this.deliveries,
        requests: this.requests.length,
      });
    }
    if (method !== "POST") return send(405, { error: "POST expected" });
    const b = body();
    if (action === "profile") return send(200, this.addProfile(b as { publicIdentifier: string }));
    if (action === "accept") {
      const payload = this.accept(String(b.account_id), String(b.provider_id));
      return void this.deliverWebhook(payload).then((deliveries) => send(200, { payload, deliveries }));
    }
    if (action === "reply") {
      const payload = this.reply(String(b.account_id), String(b.provider_id), String(b.text ?? ""));
      return void this.deliverWebhook(payload).then((deliveries) => send(200, { payload, deliveries }));
    }
    if (action === "fault") {
      this.setFault(String(b.route), b.fault as Fault);
      return send(200, { ok: true });
    }
    if (action === "clear-faults") {
      this.clearFaults();
      return send(200, { ok: true });
    }
    if (action === "search-results") {
      this.searchResults = b.results as typeof this.searchResults;
      return send(200, { ok: true });
    }
    return send(404, { error: "unknown control action" });
  }

  // ---- Routes ----

  private pageSize(ctx: Ctx, max: number, fallback: number): number | Result {
    const raw = ctx.query.get("limit");
    if (raw === null) return Math.min(fallback, this.options.pageCap ?? Infinity);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) return fail(400, "errors/invalid_parameters", `limit must be an integer from 1 to ${max}`);
    return Math.min(n, this.options.pageCap ?? Infinity);
  }

  private page<T>(ctx: Ctx, all: T[], max: number, fallback: number): { items: T[]; cursor: string | null; offset: number } | Result {
    const size = this.pageSize(ctx, max, fallback);
    if (typeof size !== "number") return size;
    const offset = decodeCursor(ctx.query.get("cursor"));
    if (offset === null) return fail(400, "errors/invalid_parameters", "Invalid cursor");
    const items = all.slice(offset, offset + size);
    return { items, cursor: offset + size < all.length ? encodeCursor(offset + size) : null, offset };
  }

  private requireAccount(id: unknown): StandinAccount | Result {
    if (!is(id)) return fail(400, "errors/missing_parameters", "account_id is required");
    const account = this.accounts.find((a) => a.id === id);
    return account ?? fail(404, "errors/resource_not_found", "Account not found.");
  }

  private profileBody(p: StandinProfile): Json {
    const pending = this.invitations.some((i) => i.invitedUserId === p.providerId);
    return {
      object: "UserProfile",
      provider: "LINKEDIN",
      provider_id: p.providerId,
      public_identifier: p.publicIdentifier,
      first_name: p.firstName,
      last_name: p.lastName,
      headline: p.headline,
      location: p.location,
      profile_picture_url: "https://media.example.com/profile.jpg",
      is_premium: p.premium ?? false,
      is_self: false,
      network_distance: p.distance ?? "OUT_OF_NETWORK",
      public_profile_url: `https://www.linkedin.com/in/${p.publicIdentifier}`,
      ...(pending ? { invitation: { type: "SENT", status: "PENDING" } } : {}),
      throttled_sections: [],
    };
  }

  private chatBody(c: Chat): Json {
    const other = this.profileBy(c.attendee);
    return {
      object: "Chat",
      id: c.id,
      account_id: c.account,
      account_type: "LINKEDIN",
      provider_id: `2-${c.id}`,
      attendee_provider_id: c.attendee,
      name: other ? `${other.firstName} ${other.lastName}` : null,
      type: 0,
      timestamp: iso(c.at),
      unread_count: 0,
      archived: 0,
      muted_until: null,
      read_only: 0,
      pinned: 0,
    };
  }

  private messageBody(m: Message): Json {
    return {
      object: "Message",
      id: m.id,
      message_id: m.id,
      chat_id: m.chatId,
      provider_id: `3-${m.id}`,
      account_id: this.chats.find((c) => c.id === m.chatId)?.account,
      sender_id: m.senderId,
      text: m.text,
      timestamp: iso(m.at),
      is_sender: m.isSender ? 1 : 0,
      attachments: [],
      seen: 0,
      deleted: 0,
    };
  }

  private buildRoutes(): Route[] {
    const R = compile;
    return [
      R("GET", "/api/v1/accounts", { allowed: ["limit", "cursor"] }, "none", (ctx) => {
        const page = this.page(ctx, this.accounts, 250, 100);
        if ("body" in page) return page;
        const items = page.items.map((a) => ({
          object: "Account",
          type: a.type,
          id: a.id,
          name: a.name,
          created_at: "2025-12-31T23:59:59.999Z",
          connection_params: { im: { id: a.memberId, username: a.username, publicIdentifier: a.publicIdentifier, premiumFeatures: a.premium ? ["premium"] : [] } },
          groups: [],
          sources: [{ id: `${a.id}_MESSAGING`, status: a.status }],
        }));
        return ok({ object: "AccountList", items, cursor: page.cursor });
      }),

      R("GET", "/api/v1/users/me", { allowed: ["account_id"], required: ["account_id"] }, "none", (ctx) => {
        const account = this.requireAccount(ctx.query.get("account_id"));
        if ("body" in account) return account;
        return ok({
          object: "AccountOwnerProfile",
          provider: "LINKEDIN",
          provider_id: account.memberId,
          public_identifier: account.publicIdentifier,
          first_name: account.name.split(" ")[0],
          last_name: account.name.split(" ").slice(1).join(" "),
          headline: "Account owner",
          premium: account.premium,
        });
      }),

      R("POST", "/api/v1/users/invite", { allowed: [] }, "json", (ctx) => {
        const { provider_id, account_id, message } = ctx.json;
        if (!is(provider_id) || !is(account_id)) return fail(400, "errors/missing_parameters", "provider_id and account_id are required");
        if (message !== undefined && typeof message !== "string") return fail(400, "errors/invalid_parameters", "message must be a string");
        if (typeof message === "string" && message.length > 300) return fail(400, "errors/too_many_characters", "message is limited to 300 characters");
        const account = this.requireAccount(account_id);
        if ("body" in account) return account;
        if (account.type !== "LINKEDIN") return fail(422, "errors/invalid_account", "Provided account is not designed for this feature.");
        if (provider_id === account.memberId) return fail(422, "errors/cannot_invite_attendee", "You cannot send an invitation to your own LinkedIn profile.");
        const profile = this.profileBy(provider_id);
        if (!profile) return fail(422, "errors/invalid_recipient", "Make sure that the recipient ID is valid and that the corresponding profile is not locked.");
        if (profile.distance === "FIRST_DEGREE") return fail(422, "errors/already_connected", "You are already connected with this user.");
        if (this.invitations.some((i) => i.account === account.id && i.invitedUserId === profile.providerId)) {
          return fail(422, "errors/already_invited_recently", "An invitation has already been sent recently to this recipient. Please try again later.");
        }
        const invitation: Invitation = { id: this.nextId("inv"), account: account.id, invitedUserId: profile.providerId, publicId: profile.publicIdentifier, text: message ?? null, at: this.now() };
        this.invitations.push(invitation);
        return ok({ object: "UserInvitationSent", invitation_id: invitation.id });
      }),

      R("GET", "/api/v1/users/invite/sent", { allowed: ["account_id", "cursor", "limit"], required: ["account_id"] }, "none", (ctx) => {
        const account = this.requireAccount(ctx.query.get("account_id"));
        if ("body" in account) return account;
        const page = this.page(ctx, this.invitations.filter((i) => i.account === account.id), 100, 100);
        if ("body" in page) return page;
        return ok({
          object: "InvitationList",
          items: page.items.map((i) => {
            const p = this.profileBy(i.invitedUserId);
            return {
              object: "InvitationSent",
              id: i.id,
              invited_user: p ? `${p.firstName} ${p.lastName}` : "Unknown",
              invited_user_id: i.invitedUserId,
              invited_user_public_id: i.publicId,
              invited_user_description: p?.headline ?? "",
              date: "just now",
              parsed_datetime: iso(i.at),
              invitation_text: i.text ?? "",
            };
          }),
          cursor: page.cursor,
        });
      }),

      R("GET", "/api/v1/users/:identifier", { allowed: ["account_id", "linkedin_sections", "linkedin_api", "notify"], required: ["account_id"] }, "none", (ctx) => {
        const account = this.requireAccount(ctx.query.get("account_id"));
        if ("body" in account) return account;
        const profile = this.profileBy(ctx.params.identifier);
        return profile ? ok(this.profileBody(profile)) : fail(404, "errors/resource_not_found", "Profile not found.");
      }),

      R("GET", "/api/v1/chat_attendees/:attendee_id/chats", { allowed: ["account_id", "cursor", "before", "after", "limit"] }, "none", (ctx) => {
        const ids = ctx.params.attendee_id.split(",");
        const accountFilter = ctx.query.get("account_id")?.split(",");
        if (accountFilter && accountFilter.some((id) => !this.accounts.some((a) => a.id === id))) return fail(404, "errors/resource_not_found", "Account not found.");
        const mine = this.chats.filter((c) => ids.includes(c.attendee) && (!accountFilter || accountFilter.includes(c.account)));
        const page = this.page(ctx, mine, 250, 100);
        if ("body" in page) return page;
        return ok({ object: "ChatList", items: page.items.map((c) => this.chatBody(c)), cursor: page.cursor });
      }),

      R("POST", "/api/v1/chats", { allowed: [] }, "multipart", (ctx) => {
        const form = ctx.form!;
        const accountId = form.get("account_id");
        const attendees = form.getAll("attendees_ids").filter((v): v is string => typeof v === "string" && v !== "");
        if (!is(accountId) || attendees.length < 1) return fail(400, "errors/missing_parameters", "account_id and attendees_ids are required");
        const account = this.requireAccount(accountId);
        if ("body" in account) return account;
        const member = attendees[0];
        const profile = this.profileBy(member);
        if (!profile) return fail(422, "errors/invalid_recipient", "Make sure that the recipient ID is valid.");
        // Docs, 422: "The recipient appears not to be first degree connection."
        if (profile.distance !== "FIRST_DEGREE") return fail(422, "errors/no_connection_with_recipient", "The recipient appears not to be first degree connection.");
        const text = form.get("text");
        const chat = this.chatFor(account.id, profile.providerId) ?? this.createChat(account.id, profile.providerId);
        let messageId: string | null = null;
        if (typeof text === "string" && text !== "") {
          const message = this.addMessage(chat, account.memberId, true, text);
          messageId = message.id;
          this.maybeEcho(chat, message);
        }
        return ok({ object: "ChatStarted", chat_id: chat.id, message_id: messageId }, 201);
      }),

      R("POST", "/api/v1/chats/:chat_id/messages", { allowed: [] }, "multipart", (ctx) => {
        const chat = this.chats.find((c) => c.id === ctx.params.chat_id);
        if (!chat) return fail(404, "errors/resource_not_found", "Chat not found.");
        const form = ctx.form!;
        const accountId = form.get("account_id");
        if (accountId !== null && accountId !== chat.account) return fail(404, "errors/resource_not_found", "Chat not found for this account.");
        const text = form.get("text");
        if (!is(text)) return fail(400, "errors/missing_parameters", "text is required without attachments");
        const message = this.addMessage(chat, this.accounts.find((a) => a.id === chat.account)?.memberId ?? "", true, text);
        this.maybeEcho(chat, message);
        return ok({ object: "MessageSent", message_id: message.id }, 201);
      }),

      R("GET", "/api/v1/chats/:chat_id/messages", { allowed: ["cursor", "before", "after", "limit", "sender_id"] }, "none", (ctx) => {
        const chat = this.chats.find((c) => c.id === ctx.params.chat_id);
        if (!chat) return fail(404, "errors/resource_not_found", "Chat not found.");
        const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
        for (const name of ["after", "before"]) {
          const value = ctx.query.get(name);
          if (value !== null && !stamp.test(value)) return fail(400, "errors/invalid_parameters", `${name} must be YYYY-MM-DDTHH:MM:SS.sssZ`);
        }
        const after = ctx.query.get("after");
        const before = ctx.query.get("before");
        const sender = ctx.query.get("sender_id");
        const mine = this.messages
          .filter((m) => m.chatId === chat.id && (!after || m.at > new Date(after)) && (!before || m.at < new Date(before)) && (!sender || m.senderId === sender))
          .sort((a, b) => b.at.getTime() - a.at.getTime());
        const page = this.page(ctx, mine, 250, 100);
        if ("body" in page) return page;
        return ok({ object: "MessageList", items: page.items.map((m) => this.messageBody(m)), cursor: page.cursor });
      }),

      R("POST", "/api/v1/linkedin/search", { allowed: ["account_id", "cursor", "limit"], required: ["account_id"] }, "json", (ctx) => {
        const account = this.requireAccount(ctx.query.get("account_id"));
        if ("body" in account) return account;
        const searchUrl = ctx.json.url;
        if (!is(searchUrl)) return fail(400, "errors/missing_parameters", "url is required");
        let parsed: URL;
        try {
          parsed = new URL(searchUrl);
        } catch {
          return fail(400, "errors/invalid_url", "url is not a valid URL");
        }
        if (!/(^|\.)linkedin\.com$/.test(parsed.hostname) || !/^\/(sales\/)?search\/(results\/)?people/.test(parsed.pathname)) {
          return fail(400, "errors/invalid_url", "Only LinkedIn people search URLs are supported");
        }
        // Docs: classic people search is capped at 10 per page (limit 0 to 100).
        const limit = ctx.query.get("limit");
        if (limit !== null && (!Number.isInteger(Number(limit)) || Number(limit) < 0 || Number(limit) > 100)) return fail(400, "errors/invalid_parameters", "limit must be 0 to 100");
        const size = Math.min(Number(limit || 10), 10, this.options.pageCap ?? 10);
        const offset = decodeCursor(ctx.query.get("cursor"));
        if (offset === null) return fail(400, "errors/invalid_parameters", "Invalid cursor");
        const slice = this.searchResults.slice(offset, offset + size);
        const next = offset + size < this.searchResults.length ? encodeCursor(offset + size) : null;
        return ok({
          object: "LinkedinSearch",
          items: slice.map((p) => ({
            type: "PEOPLE",
            id: p.providerId,
            name: p.name,
            member_urn: `urn:li:member:${p.providerId}`,
            profile_url: `https://www.linkedin.com/in/${p.providerId}`,
            network_distance: p.distance ?? "DISTANCE_2",
            location: p.location ?? "United States",
            headline: p.headline ?? "",
          })),
          config: { params: { api: "classic", category: "people" } },
          paging: { start: offset, page_count: slice.length, total_count: this.searchResults.length },
          cursor: next,
        });
      }),

      // Hosted auth link. Body fields as the Unipile hosted-auth guide lists them. The stand-in does not run a wizard; tests read the link from `requests`.
      R("POST", "/api/v1/hosted/accounts/link", { allowed: [] }, "json", (ctx) => {
        const { type, providers, api_url, expiresOn, success_redirect_url, failure_redirect_url, notify_url, name, reconnect_account } = ctx.json;
        if (type !== "create" && type !== "reconnect") return fail(400, "errors/invalid_parameters", "type must be create or reconnect");
        if (!is(api_url) || !is(expiresOn) || !is(success_redirect_url) || !is(failure_redirect_url) || !is(name)) {
          return fail(400, "errors/missing_parameters", "api_url, expiresOn, success_redirect_url, failure_redirect_url and name are required");
        }
        if (Number.isNaN(Date.parse(expiresOn)) || !/Z$/.test(expiresOn)) return fail(400, "errors/invalid_parameters", "expiresOn must be an ISO 8601 UTC date");
        for (const url of [success_redirect_url, failure_redirect_url, ...(notify_url === undefined ? [] : [notify_url])]) {
          try {
            new URL(String(url));
          } catch {
            return fail(400, "errors/invalid_url", "a redirect or notify URL is not a valid URL");
          }
        }
        if (type === "create" && (!Array.isArray(providers) || providers.length === 0)) return fail(400, "errors/missing_parameters", "providers is required for type create");
        if (type === "reconnect") {
          if (!is(reconnect_account)) return fail(400, "errors/missing_parameters", "reconnect_account is required for type reconnect");
          const account = this.requireAccount(reconnect_account);
          if ("body" in account) return account;
        }
        return ok({ object: "HostedAuthURL", url: `https://account.unipile.test/authenticate?token=${this.nextId("tok")}` }, 201);
      }),

      R("GET", "/api/v1/webhooks", { allowed: ["cursor", "limit"] }, "none", (ctx) => {
        const page = this.page(ctx, this.webhooks, 250, 100);
        if ("body" in page) return page;
        return ok({
          object: "WebhookList",
          items: page.items.map((h) => ({
            object: "Webhook",
            id: h.id,
            request_url: h.requestUrl,
            account_ids: [],
            enabled: h.enabled,
            name: h.name,
            format: h.format,
            headers: h.headers,
            data: [],
            events: h.events,
            type: "AUTO",
          })),
          cursor: page.cursor,
        });
      }),

      R("POST", "/api/v1/webhooks", { allowed: [] }, "json", (ctx) => {
        const ALLOWED: Record<string, string[]> = {
          messaging: ["message_received", "message_read", "message_reaction", "message_edited", "message_deleted", "message_delivered"],
          users: ["new_relation"],
          account_status: ["creation_success", "creation_fail", "deleted", "reconnected", "sync_success", "stopped", "ok", "connecting", "error", "credentials", "permissions"],
          email: ["mail_sent", "mail_received", "mail_moved"],
          email_tracking: ["mail_opened", "mail_link_clicked"],
          calendar_event: ["calendar_event_created", "calendar_event_updated", "calendar_event_deleted"],
        };
        const { source, request_url, name, events, headers, format, enabled } = ctx.json;
        if (typeof source !== "string" || !(source in ALLOWED)) return fail(400, "errors/invalid_parameters", "source must be one of " + Object.keys(ALLOWED).join(", "));
        if (!is(request_url)) return fail(400, "errors/missing_parameters", "request_url is required");
        try {
          new URL(request_url);
        } catch {
          return fail(400, "errors/invalid_url", "request_url is not a valid URL");
        }
        if (name !== undefined && typeof name !== "string") return fail(400, "errors/invalid_parameters", "name must be a string");
        if (format !== undefined && format !== "json" && format !== "form") return fail(400, "errors/invalid_parameters", "format must be json or form");
        const eventList = events === undefined ? [ALLOWED[source][0]] : events;
        if (!Array.isArray(eventList) || eventList.some((e) => typeof e !== "string" || !ALLOWED[source].includes(e))) {
          return fail(400, "errors/invalid_parameters", `events for source ${source} must be among ${ALLOWED[source].join(", ")}`);
        }
        const headerList = headers === undefined ? [] : headers;
        if (!Array.isArray(headerList) || headerList.some((h) => !h || typeof h !== "object" || !is((h as Json).key) || typeof (h as Json).value !== "string")) {
          return fail(400, "errors/invalid_parameters", "headers must be an array of { key, value } strings");
        }
        const hook: Webhook = {
          id: this.nextId("hook"),
          source,
          requestUrl: request_url,
          name: typeof name === "string" ? name : "",
          events: eventList as string[],
          headers: headerList as Array<{ key: string; value: string }>,
          format: typeof format === "string" ? format : "json",
          enabled: enabled !== false,
        };
        this.webhooks.push(hook);
        return ok({ object: "WebhookCreated", webhook_id: hook.id }, 201);
      }),

      R("DELETE", "/api/v1/webhooks/:id", { allowed: [] }, "none", (ctx) => {
        const index = this.webhooks.findIndex((h) => h.id === ctx.params.id);
        if (index < 0) return fail(404, "errors/resource_not_found", "Webhook not found.");
        this.webhooks.splice(index, 1);
        return ok({ object: "WebhookDeleted" });
      }),
    ];
  }

  private maybeEcho(chat: Chat, message: Message): void {
    if (!this.options.echoOwnMessages) return;
    void this.deliverWebhook(this.messagePayload(chat, message));
  }
}

export async function startUnipileStandin(options: StandinOptions = {}): Promise<UnipileStandin> {
  return new UnipileStandin(options).start();
}
