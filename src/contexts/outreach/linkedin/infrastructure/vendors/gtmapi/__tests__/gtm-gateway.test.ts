import { describe, expect, it } from "vitest";
import type { LinkedInGateway, LinkedInGatewayError } from "../../../../application/linkedin-ports";
import { gatewayErrorFrom, retryAfterMs } from "../gtm-errors";
import { GtmGateway } from "../gtm-gateway";
import { GtmRequestError } from "../gtm-http";

type Answer = { status?: number; body: unknown };

/** Answers calls in order and records what was asked. Shapes follow gtm-api's OpenAPI document. */
function gateway(...answers: Answer[]) {
  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
    const next = answers.shift();
    if (!next) throw new Error("no answer left");
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { gtm: new GtmGateway({ apiKey: "gtm_live_key", fetch: fetcher }), calls };
}

const failure = (status: number, code: string, context: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Answer => ({ status, body: { success: false, error: { code, message: "Refused", context, ...extra } } });
const refused = async (call: Promise<unknown>) => (await call.then(() => null, (error: unknown) => error)) as LinkedInGatewayError;
const page = (items: unknown[], next: string | null = null) => ({ success: true, items, pagination: { next_cursor: next, has_more: next !== null, total_count: items.length } });
const account = (over: Record<string, unknown> = {}, browser: string | null = "idle") => ({ item: { sid: "ln_ac_1", status: "active", ln_id: "ACoAAowner1", nickname: "seller-one", full_name: "Sam Seller", has_premium: true, ...over }, included: browser ? { antidetect_browser: { status: browser } } : {} });
const message = { to: { chat: "member:ACoAAlead11", member: "ACoAAlead11", slug: "lead" }, text: "Hi", sendKey: "send-1", unlessRepliedAfter: null };
/** A member id at its real length. A shorter token that starts the same way can be a public slug. */
const LONG_ID = "ACoAAowner4xxxxxxxxxxxxxxxxxxxxxxxxxxxx";

describe("gtm-api errors", () => {
  const map = (error: GtmRequestError, context = {}) => gatewayErrorFrom(error, context);
  const named = (status: number, code: string, reason: string, outcome: "sent" | "not_sent" | "in_flight" | "unknown" | null = null, cause = "", retry: unknown = null) => new GtmRequestError(status, "x", true, code, reason, cause, outcome, retry);

  it("treats an answer with no envelope as unknown at any status, since a gateway page says nothing about the send", () => {
    for (const status of [0, 400, 403, 502]) expect(map(new GtmRequestError(status, "x"), { write: true })).toMatchObject({ kind: "unknown", code: "unavailable" });
  });

  it("reads the reason before the outcome: a place block answers not_sent and asks for the same request later", () => {
    expect(map(named(409, "conflict", "concurrent_send_in_flight", "not_sent"))).toMatchObject({ kind: "definite", code: "rate_limited", limits: "recipient" });
  });

  it.each(["browser_starting", "browser_unavailable", "browser_unreachable", "plugin_unavailable", "infrastructure_maintenance", "client_rate_limited", "initial_sync_pending"])("gives the attempt back on %s", (reason) => {
    const error = map(named(503, "service_unavailable", reason, null), { write: true });
    expect(error).toMatchObject({ kind: "definite", code: "rate_limited", retryAfterMs: 300_000, limits: "account" });
  });

  it.each(["concurrent_send_in_flight", "reply_check_unavailable"])("holds only this person on %s, so one thread cannot stop the account", (reason) => {
    const error = map(named(503, "service_unavailable", reason, null), { write: true });
    expect(error).toMatchObject({ kind: "definite", code: "rate_limited", retryAfterMs: 300_000, limits: "recipient" });
  });

  it.each(["sent", "in_flight", "unknown"] as const)("keeps %s unknown, even on a 4xx", (outcome) => {
    expect(map(named(409, "conflict", "send_outcome_unknown", outcome), { write: true })).toMatchObject({ kind: "unknown" });
  });

  it("calls a send error with no outcome unknown, and a read's refused", () => {
    expect(map(named(409, "conflict", "something_new"), { write: true })).toMatchObject({ kind: "unknown" });
    expect(map(named(409, "conflict", "something_new"))).toMatchObject({ kind: "definite", code: "rejected" });
  });

  it("maps resend_not_available by its cause", () => {
    const cause = (value: string) => map(named(422, "validation_failed", "resend_not_available", "not_sent", value), { write: true });
    expect(cause("pending").code).toBe("already_invited");
    expect(cause("accepted").code).toBe("already_connected");
    expect(cause("cooldown").code).toBe("rejected");
    expect(cause("linkedin").code).toBe("rejected");
  });

  it("maps the named refusals", () => {
    expect(map(named(409, "conflict", "replied", "not_sent")).code).toBe("replied");
    expect(map(named(422, "conflict", "not_connected", "not_sent")).code).toBe("not_first_degree");
    expect(map(named(422, "conflict", "sales_nav_required")).code).toBe("insufficient_privileges");
    expect(map(named(422, "conflict", "target_unresolvable")).code).toBe("not_found");
    expect(map(named(401, "unauthorized", "")).code).toBe("auth");
    expect(map(named(409, "conflict", "subscription_required", "not_sent")).code).toBe("auth");
    expect(map(named(409, "conflict", "browser_logged_out", "not_sent")).code).toBe("auth");
  });

  it("lets a budget stop only what the call's context names", () => {
    const budget = named(429, "rate_limited", "bucket_saturated", null, "daily_saturation", "2026-11-06T00:00:00Z");
    const now = Date.parse("2026-11-05T23:00:00Z");
    expect(map(budget, { limits: "invitations", now })).toMatchObject({ kind: "definite", code: "rate_limited", limits: "invitations", retryAfterMs: 3_600_000 });
    expect(map(budget, { now })).toMatchObject({ limits: "account" });
  });

  it("reads retry_after safely", () => {
    const now = Date.parse("2026-11-05T00:00:00Z");
    expect(retryAfterMs("not a time", now)).toBeNull();
    expect(retryAfterMs(30, now)).toBeNull();
    expect(retryAfterMs("2026-11-04T00:00:00Z", now)).toBe(60_000);
    expect(retryAfterMs("2027-01-01T00:00:00Z", now)).toBe(48 * 3_600_000);
  });
});

describe("gtm-api gateway", () => {
  it("sends the key as a Bearer token to the LinkedIn service", async () => {
    const { gtm, calls } = gateway({ body: page([]) });
    await gtm.verify();
    expect(calls[0]).toMatchObject({ url: "https://app.gtm-api.com/linkedin/v4/api/linkedin-accounts/search", auth: "Bearer gtm_live_key" });
  });

  it("lists a team's accounts, leaving ones on their first sync for later", async () => {
    const { gtm } = gateway({
      body: page(
        [
          account(),
          account({ sid: "ln_ac_2", status: "initial_syncing", ln_id: "ACoAAowner2" }),
          account({ sid: "ln_ac_3", ln_id: null }),
          account({ sid: "ln_ac_4", ln_id: "ACoAAowner4", nickname: LONG_ID }, "login_issue"),
          account({ sid: "ln_ac_5", ln_id: "ACoAAowner5", nickname: "five", status: "subscription_required" }),
          account({ sid: "ln_ac_6", ln_id: "ACoAAowner6", nickname: "six" }, null),
        ],
        "next",
      ),
    }, { body: page([account({ sid: "ln_ac_7", ln_id: "ACoAAowner7", nickname: "seven" }, "restricted")]) });
    expect(await gtm.listAccounts()).toEqual([
      { ref: "ln_ac_1", linkedinId: "ACoAAowner1", name: "Sam Seller", username: "seller-one", status: "connected" },
      { ref: "ln_ac_4", linkedinId: "ACoAAowner4", name: "Sam Seller", username: null, status: "disconnected" },
      { ref: "ln_ac_5", linkedinId: "ACoAAowner5", name: "Sam Seller", username: "five", status: "disconnected" },
      { ref: "ln_ac_6", linkedinId: "ACoAAowner6", name: "Sam Seller", username: "six", status: "connected" },
      { ref: "ln_ac_7", linkedinId: "ACoAAowner7", name: "Sam Seller", username: "seven", status: "disconnected" },
    ]);
  });

  it("keeps a public slug that only looks like a member id", async () => {
    const { gtm } = gateway({ body: page([account({ nickname: "ACostaMaria" })]) });
    expect((await gtm.listAccounts())[0].username).toBe("acostamaria");
  });

  it("answers its own profile from the listing, with no call that spends a budget", async () => {
    const { gtm, calls } = gateway({ body: page([account()]) });
    await gtm.listAccounts();
    expect(await gtm.getOwnProfile("ln_ac_1")).toMatchObject({ member: "ACoAAowner1", publicSlug: "seller-one", firstName: "Sam", lastName: "Seller", isPremium: true });
    expect(calls).toHaveLength(1);
  });

  it("throws on a list answer with no rows, since a changed shape must not read as nothing", async () => {
    const { gtm } = gateway({ body: { success: true } });
    expect(await refused(gtm.listAccounts())).toMatchObject({ kind: "unknown" });
  });

  it("looks a person up by slug or by member id, pinned to the account", async () => {
    const { gtm, calls } = gateway({ body: { success: true, result: { profile: { ln_id: "ACoAAlead11", nickname: "lead", full_name: "Ada Byron", network_distance: "2nd" } } } }, { body: { success: true, result: { profile: { ln_id: "ACoAAlead11" } } } });
    expect(await gtm.getProfile({ account: "ln_ac_1", identifier: "lead" })).toMatchObject({ member: "ACoAAlead11", publicSlug: "lead", firstName: "Ada", networkDistance: "second" });
    await gtm.getProfile({ account: "ln_ac_1", identifier: LONG_ID });
    expect(calls[0].body).toEqual({ public_identifier: "lead", linkedin_account_sid: "ln_ac_1" });
    expect(calls[1].body).toEqual({ profile_id: LONG_ID, linkedin_account_sid: "ln_ac_1" });
  });

  it("looks a lead with no stored slug up by the slug in its profile URL", async () => {
    const { gtm, calls } = gateway({ body: { success: true, result: { profile: { ln_id: "ACoAAlead11" } } } });
    await gtm.getProfile({ account: "ln_ac_1", identifier: "https://www.linkedin.com/in/ada-lovelace/" });
    expect(calls[0].body).toEqual({ public_identifier: "ada-lovelace", linkedin_account_sid: "ln_ac_1" });
  });

  it("holds invitations alone when a lookup runs out of budget", async () => {
    const { gtm } = gateway(failure(429, "rate_limited", { reason: "bucket_saturated", retry_after: "2099-01-01T00:00:00Z" }));
    expect(await refused(gtm.getProfile({ account: "ln_ac_1", identifier: "lead" }))).toMatchObject({ code: "rate_limited", limits: "invitations", retryAfterMs: 48 * 3_600_000 });
  });

  it("sends an invitation under its key", async () => {
    const { gtm, calls } = gateway({ body: { success: true, item: { invitation_id: "inv-1" } } });
    expect(await gtm.sendInvitation({ account: "ln_ac_1", member: "ACoAAlead11", note: "Hello", sendKey: "send-1" })).toEqual({ invitationId: "inv-1" });
    expect(calls[0].body).toEqual({ linkedin_account_sid: "ln_ac_1", profile_id: "ACoAAlead11", client_reference: "send-1", note: "Hello" });
  });

  it("reads resend_not_available from field_errors, where a validation failure keeps it", async () => {
    const { gtm } = gateway(failure(422, "validation_failed", { cause: "pending", send_outcome: "not_sent" }, { field_errors: { profile_id: [{ rule: "resend_not_available" }] } }));
    expect(await refused(gtm.sendInvitation({ account: "ln_ac_1", member: "ACoAAlead11", note: null, sendKey: "send-1" }))).toMatchObject({ kind: "definite", code: "already_invited" });
  });

  it("holds invitations alone on an invitation budget, and the account on a message budget", async () => {
    const budget = failure(429, "rate_limited", { reason: "bucket_saturated", send_outcome: "not_sent" });
    expect(await refused(gateway(budget).gtm.sendInvitation({ account: "a", member: "ACoAAlead11", note: null, sendKey: "k" }))).toMatchObject({ limits: "invitations" });
    expect(await refused(gateway(budget).gtm.sendMessage({ account: "a", ...message }))).toMatchObject({ limits: "account" });
  });

  it("sends a message by the person and never by a chat, so a retry keeps its place", async () => {
    const { gtm, calls } = gateway({ body: { success: true, item: { sid: "ln_ms_1", linkedin_conversation_sid: "ln_cv_1" } } });
    const at = new Date("2026-11-01T00:00:00Z");
    expect(await gtm.sendMessage({ account: "ln_ac_1", ...message, to: { ...message.to, chat: "ln_cv_1" }, unlessRepliedAfter: at })).toEqual({ chat: null, messageId: "ln_ms_1" });
    expect(calls[0].body).toEqual({ linkedin_account_sid: "ln_ac_1", ln_id: "ACoAAlead11", text: "Hi", client_reference: "send-1", stop_if_replied_after: "2026-11-01T00:00:00.000Z" });
  });

  it("leaves the check out when there is no moment to check from", async () => {
    const { gtm, calls } = gateway({ body: { success: true, item: { sid: "m" } } });
    await gtm.sendMessage({ account: "ln_ac_1", ...message });
    expect(calls[0].body).not.toHaveProperty("stop_if_replied_after");
  });

  it("refuses a message to nobody before calling, and strips nothing into a chat", async () => {
    const { gtm, calls } = gateway();
    expect(await refused(gtm.sendMessage({ account: "a", ...message, to: { chat: "member:x", member: null, slug: null } }))).toMatchObject({ kind: "definite", code: "invalid_recipient" });
    expect(calls).toHaveLength(0);
  });

  it("names a reply it saw as replied, with nothing sent", async () => {
    const { gtm } = gateway(failure(409, "conflict", { reason: "replied", send_outcome: "not_sent", linkedin_message_sid: "ln_ms_9" }));
    expect(await refused(gtm.sendMessage({ account: "a", ...message }))).toMatchObject({ kind: "definite", code: "replied" });
  });

  it("calls a 200 without success unknown", async () => {
    const { gtm } = gateway({ body: {} });
    expect(await refused(gtm.sendMessage({ account: "a", ...message }))).toMatchObject({ kind: "unknown" });
  });

  it("asks check-sent by key alone, and adds a place only when gtm-api asks", async () => {
    const { gtm, calls } = gateway(failure(422, "validation_failed", {}, { field_errors: { place: [{ rule: "place_required" }] } }), { body: { success: true, item: { sid: "ln_ms_1" }, result: { outcome: "sent" } } });
    expect(await gtm.findSentMessage({ account: "ln_ac_1", to: message.to, text: "Hi", since: new Date(), sendKey: "send-1" })).toEqual({ messageId: "ln_ms_1" });
    expect(calls[0].body).toEqual({ linkedin_account_sid: "ln_ac_1", client_reference: "send-1" });
    expect(calls[1].body).toEqual({ linkedin_account_sid: "ln_ac_1", client_reference: "send-1", profile_urn: "ACoAAlead11" });
  });

  it("gives a resend's go-ahead only on not_sent", async () => {
    const check = (outcome: string) => gateway({ body: { success: true, item: null, result: { outcome } } }).gtm.findSentMessage({ account: "a", to: message.to, text: "Hi", since: new Date(), sendKey: "k" });
    expect(await check("not_sent")).toBeNull();
    for (const outcome of ["unknown", "in_flight", ""]) expect(await refused(check(outcome))).toMatchObject({ kind: "unknown" });
  });

  it("reads an invitation's state from check-sent", async () => {
    const status = (outcome: string, item: unknown = null) => gateway({ body: { success: true, item, result: { outcome } } }).gtm.invitationStatus({ account: "a", member: "ACoAAlead11", since: new Date(), sendKey: "k" });
    expect(await status("not_sent")).toBe("none");
    expect(await status("sent", { removal_kind: null })).toBe("pending");
    expect(await status("sent", { removal_kind: "accepted" })).toBe("accepted");
    expect(await refused(status("unknown"))).toMatchObject({ kind: "unknown" });
  });

  it("searches by the URL's product, and pages by number", async () => {
    const answer = { success: true, result: { rows: [{ ln_id: "ACoAAlead11", nickname: "lead", full_name: "Ada", connection_degree: "2nd" }, { full_name: "No id" }], paging: { has_more: true, total: null } } };
    const { gtm, calls } = gateway({ body: answer }, { body: answer });
    const first = await gtm.searchPeople({ account: "a", searchUrl: "https://www.linkedin.com/search/results/people/?keywords=x", cursor: null });
    expect(first).toMatchObject({ nextCursor: "2", totalEstimate: null, items: [{ identifier: "lead", profileUrl: "https://www.linkedin.com/in/lead", name: "Ada" }] });
    expect(first.items).toHaveLength(1);
    await gtm.searchPeople({ account: "a", searchUrl: "https://www.linkedin.com/sales/search/people?query=x", cursor: "2" });
    expect(calls[0].url).toContain("/linkedin-scraping/search-people");
    expect(calls[1].url).toContain("/linkedin-scraping/search-sales-nav-people");
    expect(calls[1].body).toMatchObject({ page: 2 });
  });

  it("fails a search LinkedIn's monthly limit cut, so it does not show as finished", async () => {
    const { gtm } = gateway({ body: { success: true, result: { rows: [], commercial_use_limit_hit: true, paging: { has_more: false } } } });
    expect(await refused(gtm.searchPeople({ account: "a", searchUrl: "https://www.linkedin.com/search/results/people/?k=x", cursor: null }))).toMatchObject({ kind: "definite", code: "rejected" });
  });

  it("refuses a search URL gtm-api would refuse", async () => {
    const { gtm, calls } = gateway();
    expect(await refused(gtm.searchPeople({ account: "a", searchUrl: "https://www.linkedin.com/talent/search", cursor: null }))).toMatchObject({ code: "invalid_recipient" });
    expect(calls).toHaveLength(0);
  });

  it("has no connect link, because accounts connect in gtm-api's app", () => {
    expect((gateway().gtm as LinkedInGateway).createConnectLink).toBeUndefined();
  });
});
