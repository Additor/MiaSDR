import { describe, expect, it } from "vitest";
import { LinkedInGatewayError } from "../../application/linkedin-ports";
import { normalizeDsn, parseDsn } from "../../application/linkedin-management";
import { UnipileGateway, classifyHttpError } from "../unipile-gateway";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | FormData | undefined;
}

function mock(responses: Array<{ status?: number; json?: unknown } | Error>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), method: String(init?.method), headers: init?.headers as Record<string, string>, body: init?.body as Call["body"] });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next?.json ?? {}), { status: next?.status ?? 200, headers: { "content-type": "application/json" } });
  };
  const gateway = new UnipileGateway({ dsn: "api9.unipile.com:14999", apiKey: "secret-key", fetch: impl as typeof fetch });
  return { gateway, calls };
}

describe("UnipileGateway requests", () => {
  it("authenticates with X-API-KEY against the DSN host and checks credentials with a one-item account list", async () => {
    const { gateway, calls } = mock([{ json: { items: [] } }]);
    await gateway.verify();
    expect(calls[0].url.origin).toBe("https://api9.unipile.com:14999");
    expect(calls[0].url.pathname + calls[0].url.search).toBe("/api/v1/accounts?limit=1");
    expect(calls[0].headers["X-API-KEY"]).toBe("secret-key");
  });

  it("lists only LinkedIn accounts and maps their status", async () => {
    const { gateway } = mock([
      {
        json: {
          items: [
            { type: "LINKEDIN", id: "u1", name: "Ada", sources: [{ status: "OK" }], connection_params: { im: { id: "ACo1", username: "ada" } } },
            { type: "LINKEDIN", id: "u2", name: "Bo", sources: [{ status: "CREDENTIALS" }], connection_params: { im: {} } },
            { type: "WHATSAPP", id: "u3", sources: [] },
          ],
        },
      },
    ]);
    expect(await gateway.listAccounts()).toEqual([
      { ref: "u1", linkedinId: "ACo1", name: "Ada", username: "ada", status: "connected" },
      { ref: "u2", linkedinId: null, name: "Bo", username: null, status: "disconnected" },
    ]);
  });

  it("sends an invitation as JSON with provider_id, account_id and the note", async () => {
    const { gateway, calls } = mock([{ json: { object: "UserInvitationSent", invitation_id: "inv-1" } }]);
    expect(await gateway.sendInvitation({ account: "u1", member: "ACo9", note: "Hi" })).toEqual({ invitationId: "inv-1" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/api/v1/users/invite");
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body as string)).toEqual({ provider_id: "ACo9", account_id: "u1", message: "Hi" });
  });

  it("omits the message when there is no note", async () => {
    const { gateway, calls } = mock([{ json: { invitation_id: "i" } }]);
    await gateway.sendInvitation({ account: "u1", member: "ACo9", note: null });
    expect(JSON.parse(calls[0].body as string)).toEqual({ provider_id: "ACo9", account_id: "u1" });
  });

  it("looks up a profile by slug and maps the fields", async () => {
    const { gateway, calls } = mock([
      { json: { provider_id: "ACo5", public_identifier: "jane", first_name: "Jane", last_name: "Doe", headline: "CTO", network_distance: "SECOND_DEGREE", premium: true } },
    ]);
    const profile = await gateway.getProfile({ account: "u1", identifier: "https://www.linkedin.com/in/Jane/" });
    expect(calls[0].url.pathname + calls[0].url.search).toBe("/api/v1/users/jane?account_id=u1");
    expect(profile).toMatchObject({ member: "ACo5", publicSlug: "jane", firstName: "Jane", networkDistance: "second", isPremium: true });
  });

  it("keeps the case of a provider id when it looks a profile up", async () => {
    const { gateway, calls } = mock([{ json: { provider_id: "ACoAAB1Xy", network_distance: "FIRST_DEGREE" } }]);
    await gateway.getProfile({ account: "u1", identifier: "ACoAAB1Xy" });
    expect(calls[0].url.pathname).toBe("/api/v1/users/ACoAAB1Xy");
  });

  it("sends linkedin_api only when a Sales Navigator or Recruiter lookup asks for it, and keeps the id case", async () => {
    const { gateway, calls } = mock([{ json: { provider_id: "ACwAAAbCdEfGh" } }, { json: { provider_id: "ACwAAAbCdEfGh" } }, { json: { provider_id: "ACwAAAbCdEfGh" } }]);
    await gateway.getProfile({ account: "u 1", identifier: "ACwAAAbCdEfGh", linkedinApi: "sales_navigator" });
    await gateway.getProfile({ account: "u 1", identifier: "ACwAAAbCdEfGh", linkedinApi: "recruiter" });
    await gateway.getProfile({ account: "u 1", identifier: "ACwAAAbCdEfGh" });
    expect(calls[0].url.pathname).toBe("/api/v1/users/ACwAAAbCdEfGh");
    expect(calls[0].url.searchParams.get("linkedin_api")).toBe("sales_navigator");
    expect(calls[0].url.searchParams.get("account_id")).toBe("u 1");
    expect(calls[0].url.search).toBe("?account_id=u+1&linkedin_api=sales_navigator");
    expect(calls[1].url.searchParams.get("linkedin_api")).toBe("recruiter");
    expect(calls[2].url.searchParams.has("linkedin_api")).toBe(false);
  });

  it("keeps the case of a member id that is not a provider id, and still lowercases a slug", async () => {
    const { gateway, calls } = mock([{ json: { provider_id: "x" } }, { json: { provider_id: "x" } }, { json: { provider_id: "x" } }]);
    await gateway.getProfile({ account: "u1", identifier: "Ab12Cd34Ef56", linkedinApi: "recruiter" });
    await gateway.getProfile({ account: "u1", identifier: "Ab12Cd34Ef56Gh78Ij90Kl", linkedinApi: "sales_navigator" });
    await gateway.getProfile({ account: "u1", identifier: "Jane-Doe" });
    expect(calls[0].url.pathname).toBe("/api/v1/users/Ab12Cd34Ef56");
    expect(calls[1].url.pathname).toBe("/api/v1/users/Ab12Cd34Ef56Gh78Ij90Kl");
    expect(calls[2].url.pathname).toBe("/api/v1/users/jane-doe");
  });

  it("treats a success status with a body that is not JSON as an unknown outcome", async () => {
    const impl = async () => new Response("<html>proxy</html>", { status: 200 });
    const gateway = new UnipileGateway({ dsn: "api1.unipile.com:13111", apiKey: "k", fetch: impl as typeof fetch });
    await expect(gateway.sendInvitation({ account: "u1", member: "ACo1", note: null })).rejects.toMatchObject({ kind: "unknown" });
    await expect(gateway.verify()).rejects.toBeInstanceOf(LinkedInGatewayError);
  });

  it("uses the scheme parseDsn decided, and agrees with normalizeDsn on odd forms", async () => {
    const seen: string[] = [];
    const impl = async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("{}", { status: 200 });
    };
    const policy = { allowedHosts: [], allowLoopback: true };
    const table: Array<[string, string | null]> = [
      ["API1.Unipile.COM:13111", "https://api1.unipile.com:13111"],
      ["https://api1.unipile.com:443/", "https://api1.unipile.com"],
      ["api1.unipile.com.", null],
      ["http://api1.unipile.com:13111", null],
      ["xn--bcher-kva.unipile.com", "https://xn--bcher-kva.unipile.com"],
      ["bücher.unipile.com", "https://xn--bcher-kva.unipile.com"],
      ["127.0.0.1:4000", "http://127.0.0.1:4000"],
      ["LOCALHOST:4000", "http://localhost:4000"],
      ["http://localhost:80", "http://localhost"],
      ["evil-127.0.0.1.example.com:4000", null],
    ];
    for (const [input, expected] of table) {
      const parsed = parseDsn(input, policy);
      expect(normalizeDsn(input, policy)).toBe(parsed?.host ?? null);
      if (expected === null) {
        expect(parsed).toBeNull();
        continue;
      }
      expect(parsed).not.toBeNull();
      await new UnipileGateway({ dsn: parsed!.host, scheme: parsed!.scheme, apiKey: "k", fetch: impl as typeof fetch }).verify();
      expect(seen.at(-1)?.split("/api/v1")[0]).toBe(expected);
    }
  });

  it("stays on https without a scheme, even for a loopback host", async () => {
    const seen: string[] = [];
    const impl = async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("{}", { status: 200 });
    };
    await new UnipileGateway({ dsn: "127.0.0.1:4000", apiKey: "k", fetch: impl as typeof fetch }).verify();
    expect(seen[0]?.startsWith("https://127.0.0.1:4000")).toBe(true);
  });

  it("sends messages and starts chats as multipart forms", async () => {
    const { gateway, calls } = mock([{ json: { message_id: "m1" } }, { json: { chat_id: "c1", message_id: "m2" } }]);
    expect(await gateway.sendMessage({ account: "u1", chat: "c/1", text: "Hello" })).toEqual({ messageId: "m1" });
    expect(calls[0].url.pathname).toBe("/api/v1/chats/c%2F1/messages");
    expect((calls[0].body as FormData).get("text")).toBe("Hello");
    expect(calls[0].headers["content-type"]).toBeUndefined();

    expect(await gateway.startChat({ account: "u1", member: "ACo9", text: "Hello" })).toEqual({ chat: "c1", messageId: "m2" });
    const form = calls[1].body as FormData;
    expect(calls[1].url.pathname).toBe("/api/v1/chats");
    expect(form.getAll("attendees_ids")).toEqual(["ACo9"]);
    expect(form.get("account_id")).toBe("u1");
  });

  it("finds an existing chat through the attendee route", async () => {
    const { gateway, calls } = mock([{ json: { items: [{ id: "chat-7" }] } }, { json: { items: [] } }]);
    expect(await gateway.findChat({ account: "u1", member: "ACo9" })).toBe("chat-7");
    expect(calls[0].url.pathname + calls[0].url.search).toBe("/api/v1/chat_attendees/ACo9/chats?account_id=u1&limit=1");
    expect(await gateway.findChat({ account: "u1", member: "ACo9" })).toBeNull();
  });

  it("finds a sent message by its text among the account owner's messages", async () => {
    const { gateway } = mock([{ json: { items: [{ id: "a", is_sender: 0, text: "Hello" }, { id: "b", is_sender: 1, text: " Hello " }] } }]);
    expect(await gateway.findSentMessage({ account: "u1", chat: "c", text: "Hello", since: new Date("2026-10-14T10:00:00Z") })).toEqual({ messageId: "b" });
  });

  it("searches with the pasted URL in the body and the cursor in the query", async () => {
    const { gateway, calls } = mock([
      { json: { items: [{ type: "PEOPLE", id: "1", public_identifier: "ada", name: "Ada", headline: "CEO", network_distance: "DISTANCE_2" }], cursor: "next", paging: { total_count: 42 } } },
    ]);
    const page = await gateway.searchPeople({ account: "u1", searchUrl: "https://www.linkedin.com/sales/search/people?query=x", cursor: "c0" });
    expect(calls[0].url.pathname + calls[0].url.search).toBe("/api/v1/linkedin/search?account_id=u1&cursor=c0");
    expect(JSON.parse(calls[0].body as string)).toEqual({ url: "https://www.linkedin.com/sales/search/people?query=x" });
    expect(page).toMatchObject({ nextCursor: "next", totalEstimate: 42, items: [{ identifier: "ada", name: "Ada" }] });
  });

  it("reports a pending invitation, an accepted one through the profile, or none", async () => {
    const pending = mock([{ json: { items: [{ invited_user_id: "ACo9" }] } }]);
    expect(await pending.gateway.invitationStatus({ account: "u1", member: "ACo9" })).toBe("pending");
    const accepted = mock([{ json: { items: [] } }, { json: { provider_id: "ACo9", network_distance: "FIRST_DEGREE" } }]);
    expect(await accepted.gateway.invitationStatus({ account: "u1", member: "ACo9" })).toBe("accepted");
    const none = mock([{ json: { items: [] } }, { json: { provider_id: "ACo9", network_distance: "THIRD_DEGREE" } }]);
    expect(await none.gateway.invitationStatus({ account: "u1", member: "ACo9" })).toBe("none");
  });

  it("replaces earlier registrations of the same URL and creates both webhooks with the secret header", async () => {
    const { gateway, calls } = mock([
      { json: { items: [{ id: "old", request_url: "https://app/hook" }, { id: "other", request_url: "https://else" }] } },
      { json: {} },
      { json: { webhook_id: "w1" }, status: 201 },
      { json: { webhook_id: "w2" }, status: 201 },
    ]);
    const result = await gateway.registerWebhooks({ requestUrl: "https://app/hook", secret: "s3", name: "MiaSDR" });
    expect(result.registered).toEqual(["users:new_relation", "messaging:message_received"]);
    expect(calls[1]).toMatchObject({ method: "DELETE" });
    expect(calls[1].url.pathname).toBe("/api/v1/webhooks/old");
    const created = JSON.parse(calls[2].body as string);
    expect(created).toMatchObject({ source: "users", request_url: "https://app/hook", events: ["new_relation"], format: "json" });
    expect(created.headers).toContainEqual({ key: "x-unipile-secret", value: "s3" });
    expect(JSON.parse(calls[3].body as string)).toMatchObject({ source: "messaging", events: ["message_received"] });
  });

  it("removes only the hooks for the URL across list pages", async () => {
    const { gateway, calls } = mock([
      { json: { items: [{ id: "a", request_url: "https://app/hook" }, { id: "b", request_url: "https://else" }], cursor: "c2" } },
      { json: {} },
      { json: { items: [{ id: "c", request_url: "https://app/hook" }] } },
      { json: {} },
    ]);
    expect(await gateway.removeWebhooks({ requestUrl: "https://app/hook" })).toEqual({ removed: 2 });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /api/v1/webhooks", "DELETE /api/v1/webhooks/a", "GET /api/v1/webhooks", "DELETE /api/v1/webhooks/c"]);
    expect(calls[2].url.searchParams.get("cursor")).toBe("c2");
  });

  it("keeps creating the second hook when the first is refused and reports each result", async () => {
    const { gateway } = mock([{ json: { items: [] } }, { json: { type: "errors/invalid_parameters", detail: "x", title: "t", status: 400 }, status: 400 }, { json: { webhook_id: "w2" }, status: 201 }]);
    const result = await gateway.registerWebhooks({ requestUrl: "https://app/hook", secret: "s3", name: "MiaSDR" });
    expect(result.registered).toEqual(["messaging:message_received"]);
    expect(result.hooks[0].error).toBeInstanceOf(Error);
    expect(result.hooks[1].error).toBeNull();
  });
});

describe("error classification", () => {
  const body = (type: string, detail = "x") => ({ type, detail, title: "t", status: 0 });

  it("treats an answer from Unipile as a refusal and a server error as unknown", () => {
    expect(classifyHttpError(500, body("errors/provider_error"))).toMatchObject({ kind: "unknown", code: "unavailable" });
    expect(classifyHttpError(504, null)).toMatchObject({ kind: "unknown" });
    expect(classifyHttpError(401, body("errors/disconnected_account"))).toMatchObject({ kind: "definite", code: "auth" });
    expect(classifyHttpError(404, null)).toMatchObject({ kind: "definite", code: "not_found" });
    expect(classifyHttpError(429, body("errors/too_many_requests"))).toMatchObject({ kind: "definite", code: "rate_limited" });
  });

  it("separates an out-of-scope refusal from a credential failure", () => {
    // Measured against the real API on 2026-10-15: GET /users/{id}?linkedin_api=sales_navigator on a classic-only account.
    const scope = { status: 401, type: "errors/insufficient_privileges", title: "Insufficient privileges", detail: "This resource seems to be out of your scopes." };
    expect(classifyHttpError(401, scope)).toMatchObject({ kind: "definite", code: "insufficient_privileges" });
    expect(classifyHttpError(403, scope)).toMatchObject({ kind: "definite", code: "insufficient_privileges" });
    expect(classifyHttpError(401, { status: 401, type: "errors/invalid_credentials", title: "Invalid credentials", detail: "Invalid credentials." })).toMatchObject({ kind: "definite", code: "auth" });
    expect(classifyHttpError(403, { status: 403, type: "errors/invalid_credentials", title: "Forbidden" })).toMatchObject({ kind: "definite", code: "auth" });
    expect(classifyHttpError(403, { status: 403, type: "errors/other", title: "Forbidden" })).toMatchObject({ code: "rejected" });
    // The type only counts on 401 and 403.
    expect(classifyHttpError(422, scope)).toMatchObject({ code: "rejected" });
    expect(classifyHttpError(500, scope)).toMatchObject({ kind: "unknown", code: "unavailable" });
  });

  it("surfaces the out-of-scope answer of a real profile lookup as insufficient_privileges and a bad key as auth", async () => {
    const scope = { status: 401, type: "errors/insufficient_privileges", title: "Insufficient privileges", detail: "This resource seems to be out of your scopes." };
    const a = mock([{ status: 401, json: scope }]);
    await expect(a.gateway.getProfile({ account: "u", identifier: "ACwAAAbCdEfGhIj", linkedinApi: "sales_navigator" })).rejects.toMatchObject({ kind: "definite", code: "insufficient_privileges" });
    const b = mock([{ status: 401, json: { status: 401, type: "errors/invalid_credentials", title: "Invalid credentials", detail: "Invalid credentials." } }]);
    await expect(b.gateway.getProfile({ account: "u", identifier: "ACwAAAbCdEfGhIj" })).rejects.toMatchObject({ code: "auth" });
  });

  it("maps the 422 invitation types", () => {
    expect(classifyHttpError(422, body("errors/cannot_resend_yet"))).toMatchObject({ code: "rate_limited" });
    expect(classifyHttpError(422, body("errors/already_invited_recently"))).toMatchObject({ code: "already_invited" });
    expect(classifyHttpError(422, body("errors/already_connected"))).toMatchObject({ code: "already_connected" });
    expect(classifyHttpError(422, body("errors/cannot_invite_attendee"))).toMatchObject({ code: "invalid_recipient" });
    expect(classifyHttpError(422, body("errors/unprocessable_entity", "The recipient appears not to be first degree connection"))).toMatchObject({ code: "not_first_degree" });
    expect(classifyHttpError(422, body("errors/other"))).toMatchObject({ code: "rejected", kind: "definite" });
  });

  it("reports a network failure or timeout as unknown", async () => {
    const { gateway } = mock([new Error("socket hang up")]);
    const error = await gateway.sendInvitation({ account: "u", member: "m", note: null }).catch((e) => e);
    expect(error).toBeInstanceOf(LinkedInGatewayError);
    expect(error).toMatchObject({ kind: "unknown", code: "unavailable" });
  });

  it("surfaces a refusal from a real call as definite", async () => {
    const { gateway } = mock([{ status: 422, json: { type: "errors/cannot_resend_yet", title: "Limit", status: 422 } }]);
    await expect(gateway.sendInvitation({ account: "u", member: "m", note: null })).rejects.toMatchObject({ kind: "definite", code: "rate_limited" });
  });

  const link = { name: "mia-abc", expiresAt: new Date("2026-10-15T10:15:00Z"), successRedirectUrl: "https://app.test/ok", failureRedirectUrl: "https://app.test/no", notifyUrl: "https://app.test/notify?link=1&secret=s" as string | null, reconnectAccount: null as string | null };

  it("creates a hosted-auth link for a new LinkedIn account", async () => {
    const { gateway, calls } = mock([{ status: 201, json: { object: "HostedAuthURL", url: "https://account.unipile.com/x" } }]);
    expect(await gateway.createHostedAuthLink(link)).toEqual({ url: "https://account.unipile.com/x" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/api/v1/hosted/accounts/link");
    expect(JSON.parse(calls[0].body as string)).toEqual({
      type: "create",
      providers: ["LINKEDIN"],
      api_url: "https://api9.unipile.com:14999",
      expiresOn: "2026-10-15T10:15:00.000Z",
      name: "mia-abc",
      success_redirect_url: "https://app.test/ok",
      failure_redirect_url: "https://app.test/no",
      notify_url: "https://app.test/notify?link=1&secret=s",
    });
  });

  it("creates a reconnect link without providers and omits a missing notify URL", async () => {
    const { gateway, calls } = mock([{ status: 201, json: { url: "https://account.unipile.com/y" } }]);
    await gateway.createHostedAuthLink({ ...link, notifyUrl: null, reconnectAccount: "acct-1" });
    const sent = JSON.parse(calls[0].body as string);
    expect(sent).toMatchObject({ type: "reconnect", reconnect_account: "acct-1" });
    expect(sent).not.toHaveProperty("providers");
    expect(sent).not.toHaveProperty("notify_url");
  });

  it("treats an answer without a URL as a definite failure", async () => {
    const { gateway } = mock([{ status: 201, json: {} }]);
    await expect(gateway.createHostedAuthLink(link)).rejects.toMatchObject({ kind: "definite", code: "rejected" });
  });
});
