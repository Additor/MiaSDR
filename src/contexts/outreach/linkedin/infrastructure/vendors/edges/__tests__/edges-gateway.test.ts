import { describe, expect, it } from "vitest";
import { LinkedInGatewayError } from "../../../../application/linkedin-ports";
import { gatewayErrorFrom } from "../edges-errors";
import { EdgesGateway } from "../edges-gateway";
import { EdgesRequestError } from "../edges-http";
import { createEdgesVendor } from "../edges-vendor";

type Answer = { status?: number; json?: unknown; next?: string } | Error;

function mock(answers: Answer[]) {
  const calls: Array<{ path: string; body: Record<string, unknown> | null; apiKey: string }> = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname.replace("/v1", "") + url.search, body: init?.body ? JSON.parse(String(init.body)) : null, apiKey: (init?.headers as Record<string, string>)["X-API-Key"] });
    const next = answers.shift();
    if (!next) throw new Error("no answer left for " + url.pathname);
    if (next instanceof Error) throw next;
    const headers = next.next ? { "x-pagination-next": `https://api.edges.run/v1/x?cursor=${next.next}` } : undefined;
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status ?? 200, headers });
  };
  return { gateway: new EdgesGateway({ apiKey: "key", fetch: impl as typeof fetch }), calls };
}

const MEMBER = "ACoAAmember1";
const since = new Date("2026-10-14T10:00:00Z");
const to = { chat: null, member: MEMBER, slug: "ada" };

describe("EdgesGateway", () => {
  it("runs actions as the identity with the key in a header", async () => {
    const { gateway, calls } = mock([{ json: { sales_navigator_profile_id: MEMBER, linkedin_profile_handle: "Ada", first_name: "Ada" } }]);
    expect(await gateway.getProfile({ account: "uid-1", identifier: "ada" })).toMatchObject({ member: MEMBER, publicSlug: "ada", firstName: "Ada" });
    expect(calls[0]).toMatchObject({ path: "/actions/linkedin-extract-people/run/live", apiKey: "key" });
    expect(calls[0].body).toMatchObject({ identity_ids: ["uid-1"], input: { linkedin_profile_url: "https://www.linkedin.com/in/ada" } });
  });

  it("addresses slugs in any script, with no second encoding, and URLs in any form people use", async () => {
    const asked = async (identifier: string) => {
      const { gateway, calls } = mock([{ json: { sales_navigator_profile_id: MEMBER } }]);
      await gateway.getProfile({ account: "u", identifier });
      return (calls[0].body as { input: { linkedin_profile_url: string } }).input.linkedin_profile_url;
    };
    expect(await asked("홍길동-12a")).toBe(`https://www.linkedin.com/in/${encodeURIComponent("홍길동-12a")}`);
    expect(await asked("jos%C3%A9-l")).toBe("https://www.linkedin.com/in/jos%C3%A9-l");
    expect(await asked("first.last")).toBe("https://www.linkedin.com/in/first.last");
    expect(await asked("http://linkedin.com/in/ada/")).toBe("https://www.linkedin.com/in/ada");
    expect(await asked("https://kr.linkedin.com/in/ada")).toBe("https://www.linkedin.com/in/ada");
    expect(await asked("https://www.linkedin.com/sales/lead/ACwAAlead,NAME")).toBe("https://www.linkedin.com/sales/lead/ACwAAlead,NAME");
  });

  it("refuses a profile with no ACoAA id, and a Recruiter member", async () => {
    await expect(mock([{ json: { linkedin_profile_id: 5 } }]).gateway.getProfile({ account: "u", identifier: "ada" })).rejects.toMatchObject({ kind: "definite", code: "not_found" });
    await expect(mock([]).gateway.getProfile({ account: "u", identifier: "x", linkedinApi: "recruiter" })).rejects.toMatchObject({ code: "insufficient_privileges" });
  });

  describe("sendInvitation", () => {
    const invite = { account: "u", member: MEMBER, note: "Hi" };

    it("sends the note and treats a pending answer as sent", async () => {
      const { gateway, calls } = mock([{ json: { pending: true } }]);
      expect(await gateway.sendInvitation(invite)).toEqual({ invitationId: null });
      expect(calls[0].body).toMatchObject({ input: { sales_navigator_profile_id: MEMBER }, parameters: { message: "Hi" } });
    });

    it("reads connected as already connected, so the lead does not wait for an acceptance that never comes", async () => {
      await expect(mock([{ json: { connected: true } }]).gateway.sendInvitation(invite)).rejects.toMatchObject({ kind: "definite", code: "already_connected" });
    });

    it("checks the sent list when the answer does not say pending, and is unsure when the list does not show it", async () => {
      const recent = new Date().toISOString();
      expect(await mock([{ json: {} }, { json: [{ sales_navigator_profile_id: MEMBER, sent_date: `"${recent}"` }] }]).gateway.sendInvitation(invite)).toEqual({ invitationId: null });
      await expect(mock([{ json: {} }, { json: [] }]).gateway.sendInvitation(invite)).rejects.toMatchObject({ kind: "unknown" });
      await expect(mock([{ json: {} }, { json: [{ sales_navigator_profile_id: MEMBER, sent_date: "2020-01-01T00:00:00Z" }] }]).gateway.sendInvitation(invite)).rejects.toMatchObject({ kind: "unknown" });
    });
  });

  describe("invitationStatus", () => {
    const check = { account: "u", member: MEMBER, since };

    it("finds a pending invitation, then an accepted one", async () => {
      expect(await mock([{ json: [{ sales_navigator_profile_id: MEMBER }] }]).gateway.invitationStatus(check)).toBe("pending");
      expect(await mock([{ json: [] }, { json: [{ sales_navigator_profile_id: MEMBER }] }]).gateway.invitationStatus(check)).toBe("accepted");
    });

    it("answers none only after both lists were read back past the claim", async () => {
      const old = [{ sales_navigator_profile_id: "ACoAAother", sent_date: "2020-01-01T00:00:00Z", connected_at: "2020-01-01T00:00:00Z" }];
      expect(await mock([{ json: old, next: "more" }, { json: old, next: "more" }]).gateway.invitationStatus(check)).toBe("none");
      const pages = Array.from({ length: 10 }, () => ({ json: [{ sales_navigator_profile_id: "ACoAAother", sent_date: "2030-01-01T00:00:00Z" }], next: "more" }));
      await expect(mock(pages).gateway.invitationStatus(check)).rejects.toMatchObject({ kind: "unknown" });
    });
  });

  describe("sendMessage", () => {
    it("goes to the public profile, and answers the thread", async () => {
      const { gateway, calls } = mock([{ json: { linkedin_thread_id: "2-t", linkedin_message_id: "m1", is_sent: true } }]);
      expect(await gateway.sendMessage({ account: "u", to, text: "Hello" })).toEqual({ chat: "2-t", messageId: "m1" });
      expect(calls[0].body).toMatchObject({ input: { linkedin_profile_url: "https://www.linkedin.com/in/ada" }, parameters: { message: "Hello" } });
    });

    it("falls back to the member id", async () => {
      const { gateway, calls } = mock([{ json: { linkedin_message_id: "m1" } }]);
      await gateway.sendMessage({ account: "u", to: { chat: "2-known", member: MEMBER, slug: null }, text: "Hello" });
      expect(calls[0].body).toMatchObject({ input: { linkedin_profile_url: `https://www.linkedin.com/in/${MEMBER}` } });
    });

    it("refuses when no person is known, since Edges cannot send into a thread by its id", async () => {
      await expect(mock([]).gateway.sendMessage({ account: "u", to: { chat: "2-t", member: null, slug: null }, text: "Hi" })).rejects.toMatchObject({ kind: "definite", code: "invalid_recipient" });
    });

    it("is unsure when the answer does not say it was sent", async () => {
      await expect(mock([{ json: { is_sent: false } }]).gateway.sendMessage({ account: "u", to, text: "Hi" })).rejects.toMatchObject({ kind: "unknown" });
      await expect(mock([{ json: {} }]).gateway.sendMessage({ account: "u", to, text: "Hi" })).rejects.toMatchObject({ kind: "unknown" });
    });
  });

  describe("findSentMessage, whose null leads to a resend", () => {
    const find = { account: "u", to: { chat: "2-t", member: MEMBER, slug: null }, text: "Hello  there", since };
    const late = "2026-10-14T10:05:00Z";

    it("finds our text in the thread, across pages", async () => {
      const { gateway, calls } = mock([{ json: [], next: "more" }, { json: [{ content: "Hello there", delivered_at: late, message_id: "m9" }] }]);
      expect(await gateway.findSentMessage(find)).toEqual({ messageId: "m9" });
      expect(calls[1].path).toContain("cursor=more");
    });

    it("ignores the same text from before the send", async () => {
      expect(await mock([{ json: [{ content: "Hello there", delivered_at: "2026-10-01T00:00:00Z", message_id: "old" }] }]).gateway.findSentMessage(find)).toBeNull();
    });

    it("does not take the lead's own words for our message", async () => {
      expect(await mock([{ json: [{ content: "Hello there", delivered_at: late, message_id: "theirs", sales_navigator_profile_id: MEMBER }] }]).gateway.findSentMessage(find)).toBeNull();
    });

    it("gives no answer when the list comes back in another shape, or not as JSON", async () => {
      await expect(mock([{ json: { error: "busy" } }]).gateway.findSentMessage(find)).rejects.toMatchObject({ kind: "unknown" });
      const impl = async () => new Response("<html>busy</html>", { status: 200 });
      await expect(new EdgesGateway({ apiKey: "k", fetch: impl as never }).findSentMessage(find)).rejects.toMatchObject({ kind: "unknown" });
    });

    it("gives no answer when the thread is too long to finish", async () => {
      const pages = Array.from({ length: 10 }, () => ({ json: [], next: "more" }));
      await expect(mock(pages).gateway.findSentMessage(find)).rejects.toMatchObject({ kind: "unknown" });
    });

    it("looks for the thread by person, and says none only after reading conversations past the send", async () => {
      const byPerson = { ...find, to: { chat: null, member: MEMBER, slug: null } };
      const thread = { linkedin_thread_id: "2-found", last_activity_at: late, participants: [{ sales_navigator_profile_id: MEMBER }] };
      expect(await mock([{ json: [thread] }, { json: [{ content: "Hello there", delivered_at: late, message_id: "m2" }] }]).gateway.findSentMessage(byPerson)).toEqual({ messageId: "m2" });
      expect(await mock([{ json: [{ linkedin_thread_id: "2-other", last_activity_at: "2020-01-01T00:00:00Z", participants: [{ sales_navigator_profile_id: "ACoAAother" }] }], next: "more" }]).gateway.findSentMessage(byPerson)).toBeNull();
      const pages = Array.from({ length: 10 }, () => ({ json: [{ linkedin_thread_id: "2-other", last_activity_at: late, participants: [] }], next: "more" }));
      await expect(mock(pages).gateway.findSentMessage(byPerson)).rejects.toMatchObject({ kind: "unknown" });
    });

    it("treats a placeholder chat as no thread", async () => {
      const { gateway, calls } = mock([{ json: [] }]);
      expect(await gateway.findSentMessage({ ...find, to: { chat: `member:${MEMBER}`, member: MEMBER, slug: null } })).toBeNull();
      expect(calls[0].path).toContain("linkedin-extract-conversations");
    });
  });

  it("searches classic URLs only, and pages by the header", async () => {
    await expect(mock([]).gateway.searchPeople({ account: "u", searchUrl: "https://www.linkedin.com/sales/search/people?x=1", cursor: null })).rejects.toMatchObject({ kind: "definite", code: "rejected" });
    const { gateway } = mock([{ json: [{ linkedin_profile_handle: "ada", full_name: "Ada L" }], next: "abc" }]);
    expect(await gateway.searchPeople({ account: "u", searchUrl: "https://www.linkedin.com/search/results/people/?keywords=x", cursor: null })).toMatchObject({ items: [{ identifier: "ada", name: "Ada L" }], nextCursor: "abc" });
  });

  describe("accounts", () => {
    it("lists only the identities it is asked about, and never the workspace", async () => {
      expect(await mock([]).gateway.listAccounts()).toEqual([]);
      const { gateway, calls } = mock([{ json: { status: "VALID" } }, { json: { status: "PENDING" } }]);
      expect((await gateway.listAccounts(["a", "b"])).map((x) => x.status)).toEqual(["connected", "disconnected"]);
      expect(calls.map((c) => c.path)).toEqual(["/identities/a/integrations/linkedin", "/identities/b/integrations/linkedin"]);
    });

    it("names who is signed in, so a sync can tell someone else's sign-in from the account's own", async () => {
      const { gateway } = mock([{ json: { status: "VALID", meta: { url: "https://www.linkedin.com/in/Ada-L/" } } }]);
      expect(await gateway.listAccounts(["a"])).toEqual([{ ref: "a", linkedinId: null, name: null, username: "ada-l", status: "connected" }]);
      const hashed = mock([{ json: { status: "VALID", meta: { url: `https://www.linkedin.com/in/${MEMBER}aaaaaaaaaaaaaaaaaaaa` } } }]);
      expect((await hashed.gateway.listAccounts(["a"]))[0].username).toBeNull();
    });

    it("words a failed status check as the port's error", async () => {
      await expect(mock([{ status: 401, json: {} }]).gateway.integrationStatus("a")).rejects.toMatchObject({ kind: "definite", code: "auth" });
      await expect(mock([{ status: 500, json: {} }]).gateway.removeUnusedIdentity("a")).rejects.toBeInstanceOf(LinkedInGatewayError);
    });

    it("creates an engagement identity in the organization's zone, falls back to standard, and names the account in the link", async () => {
      const input = { name: "n", expiresAt: since, successRedirectUrl: "", failureRedirectUrl: "", notifyUrl: null, reconnectAccount: null, timeZone: "Asia/Seoul" };
      const fallback = mock([{ status: 400, json: { message: "no engagement" } }, { json: { uid: "uid-9", identity_login_links: { linkedin: "https://login" } } }]);
      expect(await fallback.gateway.createConnectLink(input)).toEqual({ url: "https://login", account: "uid-9" });
      expect(fallback.calls.map((c) => [c.body?.type, c.body?.timezone])).toEqual([["engagement", "Asia/Seoul"], ["standard", "Asia/Seoul"]]);
      const noZone = mock([{ json: { uid: "uid-9", identity_login_links: { linkedin: "https://login" } } }]);
      await noZone.gateway.createConnectLink({ ...input, timeZone: null });
      expect(noZone.calls[0].body).not.toHaveProperty("timezone");
    });

    it("removes an identity no link came of, and reconnects the same identity", async () => {
      const input = { name: "n", expiresAt: since, successRedirectUrl: "", failureRedirectUrl: "", notifyUrl: null, reconnectAccount: null, timeZone: null };
      const broken = mock([{ json: { uid: "uid-9" } }, { json: {} }, { json: {} }]);
      await expect(broken.gateway.createConnectLink(input)).rejects.toBeInstanceOf(LinkedInGatewayError);
      expect(broken.calls[2].path).toBe("/identities/uid-9");
      const again = mock([{ json: { linkedin: "https://again" } }]);
      expect(await again.gateway.createConnectLink({ ...input, reconnectAccount: "uid-1" })).toEqual({ url: "https://again", account: "uid-1" });
    });

    it("removes an unused identity whatever its sign-in, because nothing here would pick it up, and takes one already gone as done", async () => {
      const { gateway, calls } = mock([{ json: {} }]);
      await gateway.removeUnusedIdentity("uid-1");
      expect(calls.map((c) => c.path)).toEqual(["/identities/uid-1"]);
      await expect(mock([{ status: 404, json: { error_label: "WORKSPACE_IDENTITY_404_NOT_FOUND" } }]).gateway.removeUnusedIdentity("uid-1")).resolves.toBeUndefined();
    });

    it("gives no answer for a list that comes back empty, since none allows a second invitation", async () => {
      const impl = async () => new Response("", { status: 200 });
      await expect(new EdgesGateway({ apiKey: "k", fetch: impl as never }).invitationStatus({ account: "u", member: MEMBER, since })).rejects.toMatchObject({ kind: "unknown" });
    });
  });
});

describe("the Edges vendor's sentences", () => {
  const vendor = createEdgesVendor();
  const asked = (status: number, label: string) => gatewayErrorFrom(new EdgesRequestError(status, label, "m"), 0);

  it("blames the key only for a refused key, and a lost sign-in for a lost sign-in", () => {
    expect(vendor.explain(asked(401, ""))).toMatch(/rejected the API key/);
    expect(vendor.explainSyncFailure(asked(401, ""))).toMatch(/rejected the saved key/);
    for (const lost of [asked(404, "WORKSPACE_IDENTITY_404_NOT_FOUND"), asked(424, "LK_BAD_COOKIE")]) {
      expect(lost.code).toBe("auth");
      expect(vendor.explain(lost)).toMatch(/no longer holds this LinkedIn sign-in/);
      expect(vendor.explainSyncFailure(lost)).toMatch(/no longer holds this LinkedIn sign-in/);
    }
  });
});

describe("gatewayErrorFrom", () => {
  const error = (status: number, label: string, message = "m", appendix: string | null = null, params: Record<string, unknown> | null = null) => gatewayErrorFrom(new EdgesRequestError(status, label, message, appendix, params), 0);

  it("reads a lost answer as unknown, because no write takes an idempotency key", () => {
    for (const e of [error(0, "unreachable"), error(500, ""), error(424, "LK_524"), error(424, ""), error(424, "LK_ERROR", "boom")]) expect(e).toMatchObject({ kind: "unknown", code: "unavailable" });
    expect(gatewayErrorFrom(new Error("socket"))).toMatchObject({ kind: "unknown" });
  });

  it("disconnects only for a lost sign-in or a rejected key", () => {
    for (const e of [error(424, "LK_BAD_COOKIE"), error(424, "INVALID_INTEGRATION"), error(401, ""), error(404, "WORKSPACE_IDENTITY_404_NOT_FOUND")]) expect(e.code).toBe("auth");
    expect(error(402, "")).toMatchObject({ code: "rate_limited", retryAfterMs: 3_600_000 });
    expect(error(403, "NO_ACCESS").code).toBe("rate_limited");
    expect(error(424, "INVALID_INTEGRATION", "m", "TEMPORARILY_RESTRICTED").code).toBe("rate_limited");
  });

  it("gives a short limit a short pause, and a long one the full pause", () => {
    expect(error(429, "RATE_LIMITED")).toMatchObject({ code: "rate_limited", retryAfterMs: 300_000 });
    expect(error(424, "LIMIT_REACHED", "m", "MINUTE_LIMIT")).toMatchObject({ code: "rate_limited", retryAfterMs: 300_000 });
    expect(error(424, "LIMIT_REACHED", "m", "DAILY_LIMIT")).toMatchObject({ code: "rate_limited", retryAfterMs: null });
    expect(error(424, "LIMIT_REACHED", "m", "DAILY_LIMIT", { postponed_until: "1970-01-01T00:10:00Z" })).toMatchObject({ retryAfterMs: 600_000 });
  });

  it("fails only the lead on the note cap, so the account keeps its messages and replies", () => {
    expect(error(424, "LIMIT_REACHED", "You reached the limit of personalized invitations")).toMatchObject({ kind: "definite", code: "invalid_recipient" });
  });

  it("names refusals for one person", () => {
    expect(error(424, "NOT_CONNECTED").code).toBe("not_first_degree");
    expect(error(424, "NO_RESULT").code).toBe("not_found");
    expect(error(424, "LK_ERROR", "cannot re-send connection request yet").code).toBe("invalid_recipient");
    expect(error(400, "")).toMatchObject({ kind: "definite", code: "rejected" });
  });
});
