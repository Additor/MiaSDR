import { describe, expect, it } from "vitest";
import { LinkedInGatewayError, isSubmitted, type GatewayProfile, type SearchPage } from "../../../../application/linkedin-ports";
import { LinkedApiGateway, preferredAccounts } from "../linkedapi-gateway";

/** Answers written from Linked API's documentation. Each pins one rule the engines rely on. */

type Answer = { status?: number; body: unknown };
const ok = (result: unknown): Answer => ({ body: { success: true, result } });
const refused = (type: string, status = 400, message = "words"): Answer => ({ status, body: { success: false, error: { type, message } } });

let tag = 0;

function gatewayWith(routes: Record<string, Answer | ((body: Record<string, unknown> | null) => Answer)>) {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; token: string | null }> = [];
  const listing = ok({ accounts: [{ id: "acct", identificationToken: "id-token", status: "active", url: "https://www.linkedin.com/in/owner", name: "Jo Owner", connectedAt: "2026-11-01T00:00:00Z" }] });
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.linkedapi.io", "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? "GET", path, body, token: (init?.headers as Record<string, string>)["identification-token"] ?? null });
    const route = routes[`${init?.method} ${path}`] ?? (path === "/admin/accounts.getAll" ? listing : undefined);
    if (!route) throw new Error(`no route for ${init?.method} ${path}`);
    const answer = typeof route === "function" ? route(body) : route;
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  tag += 1;
  return { gateway: new LinkedApiGateway({ apiKey: `k-${tag}`, fetch: fetcher }), calls };
}

const started = ok({ workflowId: "wf-1", workflowStatus: "pending" });
const SUBMIT = "POST /workflows";
const READ = "GET /workflows/wf-1";
const failure = async (call: Promise<unknown>) => {
  const outcome = await call.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(LinkedInGatewayError);
  return outcome as LinkedInGatewayError;
};

const progress = (answer: Answer, kind: "invitation" | "message" | "lookup" | "search" | "reply_check" = "message") => gatewayWith({ [READ]: answer }).gateway.operations.progress({ account: "acct", operation: "wf-1", kind });

describe("submitting", () => {
  it("sends a message into a real thread with both tokens, and answers the workflow", async () => {
    const { gateway, calls } = gatewayWith({ [SUBMIT]: started });
    const answer = await gateway.sendMessage({ account: "acct", to: { chat: "2-abc", member: "ACoAAx", slug: "ada" }, text: "Hi", sendKey: "s", unlessRepliedAfter: null });
    expect(answer).toEqual({ operation: "wf-1" });
    const call = calls.find((c) => c.path === "/workflows");
    expect(call).toMatchObject({ token: "id-token", body: { actionType: "st.sendMessage", threadId: "2-abc", text: "Hi" } });
  });

  it("addresses a person when the chat is only this app's own name for one", async () => {
    const { gateway, calls } = gatewayWith({ [SUBMIT]: started });
    await gateway.sendMessage({ account: "acct", to: { chat: "member:ACoAAx", member: "ACoAAx", slug: null }, text: "Hi", sendKey: "s", unlessRepliedAfter: null });
    expect(calls.find((c) => c.path === "/workflows")?.body).toMatchObject({ personUrl: "https://www.linkedin.com/in/ACoAAx" });
  });

  it("refuses text over its limits before any call", async () => {
    const { gateway, calls } = gatewayWith({});
    expect(await failure(gateway.sendMessage({ account: "acct", to: { chat: "2-a", member: null, slug: null }, text: "x".repeat(1901), sendKey: "s", unlessRepliedAfter: null }))).toMatchObject({ kind: "definite", code: "invalid_recipient" });
    expect(await failure(gateway.sendInvitation({ account: "acct", member: "ACoAAx", note: "x".repeat(301), sendKey: "s" }))).toMatchObject({ kind: "definite", code: "invalid_recipient" });
    expect(calls).toHaveLength(0);
  });

  it("calls a 429 on a submit definite, since nothing started", async () => {
    const { gateway } = gatewayWith({ [SUBMIT]: refused("tooManyRequests", 429) });
    expect(await failure(gateway.sendInvitation({ account: "acct", member: "ACoAAx", note: null, sendKey: "s" }))).toMatchObject({ kind: "definite", code: "rate_limited", retryAfterMs: 300_000 });
  });

  it("calls a bare 4xx unknown, since nothing says the call did not run", async () => {
    const { gateway } = gatewayWith({ [SUBMIT]: { status: 408, body: { message: "timed out" } } });
    expect(await failure(gateway.sendInvitation({ account: "acct", member: "ACoAAx", note: null, sendKey: "s" }))).toMatchObject({ kind: "unknown" });
  });

  it("calls a success with no workflow id unknown: something may be queued", async () => {
    const { gateway } = gatewayWith({ [SUBMIT]: ok({}) });
    expect(await failure(gateway.sendInvitation({ account: "acct", member: "ACoAAx", note: null, sendKey: "s" }))).toMatchObject({ kind: "unknown" });
  });

  it("takes a fresh token once after a refusal of the old one", async () => {
    let first = true;
    const { gateway, calls } = gatewayWith({
      [SUBMIT]: () => {
        if (first) {
          first = false;
          return refused("invalidIdentificationToken", 401);
        }
        return started;
      },
    });
    expect(await gateway.sendInvitation({ account: "acct", member: "ACoAAx", note: null, sendKey: "s" })).toEqual({ operation: "wf-1" });
    expect(calls.filter((c) => c.path === "/admin/accounts.getAll")).toHaveLength(2);
  });

  it("calls a send definite when the account's token could not be read, since nothing started", async () => {
    const { gateway } = gatewayWith({ "POST /admin/accounts.getAll": { status: 503, body: {} } });
    expect(await failure(gateway.sendMessage({ account: "acct", to: { chat: "2-a", member: null, slug: null }, text: "Hi", sendKey: "s", unlessRepliedAfter: null }))).toMatchObject({ kind: "definite", code: "rate_limited" });
  });

  it("disconnects an account Linked API no longer lists", async () => {
    const { gateway } = gatewayWith({ [SUBMIT]: started });
    expect(await failure(gateway.sendInvitation({ account: "gone", member: "ACoAAx", note: null, sendKey: "s" }))).toMatchObject({ kind: "definite", code: "auth" });
  });

  it("looks up by URL, by member id and on Sales Navigator, and refuses Recruiter", async () => {
    const { gateway, calls } = gatewayWith({ [SUBMIT]: started });
    await gateway.getProfile({ account: "acct", identifier: "https://www.linkedin.com/in/ada/" });
    await gateway.getProfile({ account: "acct", identifier: "ACoAAAbcdefghijklmnopqrstuvwxyz" });
    await gateway.getProfile({ account: "acct", identifier: "ACwAAAbcdefghijklmnopqrstuvwxyz", linkedinApi: "sales_navigator" });
    const bodies = calls.filter((c) => c.path === "/workflows").map((c) => c.body);
    expect(bodies[0]).toMatchObject({ actionType: "st.openPersonPage", personUrl: "https://www.linkedin.com/in/ada", basicInfo: true });
    expect(bodies[1]).toMatchObject({ personUrl: "https://www.linkedin.com/in/ACoAAAbcdefghijklmnopqrstuvwxyz" });
    expect(bodies[2]).toMatchObject({ actionType: "nv.openPersonPage", personHashedUrl: "https://www.linkedin.com/in/ACwAAAbcdefghijklmnopqrstuvwxyz" });
    expect(await failure(gateway.getProfile({ account: "acct", identifier: "AEM", linkedinApi: "recruiter" }))).toMatchObject({ code: "insufficient_privileges" });
  });

  it("searches once, by the URL's product, within what the app asked for", async () => {
    const { gateway, calls } = gatewayWith({ [SUBMIT]: started });
    await gateway.searchPeople({ account: "acct", searchUrl: "https://www.linkedin.com/search/results/people/?keywords=a", cursor: null, limit: 400 });
    await gateway.searchPeople({ account: "acct", searchUrl: "https://www.linkedin.com/sales/search/people?query=a", cursor: null, limit: 400 });
    const [classic, sales] = calls.filter((c) => c.path === "/workflows").map((c) => c.body);
    expect(classic).toMatchObject({ actionType: "st.searchPeople", limit: 400 });
    expect(sales).toMatchObject({ actionType: "nv.searchPeople" });
    expect(gateway.operations.maxSearchRead("https://www.linkedin.com/search/results/people/")).toBe(1000);
    expect(gateway.operations.maxSearchRead("https://www.linkedin.com/sales/search/people")).toBe(2500);
  });
});

describe("reading a workflow", () => {
  it("says waiting, and held only for the account's working hours", async () => {
    expect(await progress(ok({ workflowStatus: "running" }))).toEqual({ state: "waiting", held: false, started: true });
    expect(await progress(ok({ workflowStatus: "pending", pendingReason: "outsideWorkingHours" }))).toEqual({ state: "waiting", held: true, started: false });
    expect(await progress(ok({ workflowStatus: "pending", pendingReason: "accountBusy" }))).toEqual({ state: "waiting", held: false, started: false });
  });

  // A failed read must stay a throw. Reading it as a refusal would send the message twice.
  it.each([
    ["a 429", refused("tooManyRequests", 429)],
    ["a 500", { status: 500, body: { success: false } }],
    ["an unknown workflow", refused("workflowNotFound", 404)],
    ["a signed-out answer about the read itself", refused("invalidLinkedApiToken", 401)],
  ])("throws on %s", async (_, answer) => {
    await expect(progress(answer)).rejects.toThrow();
  });

  it("throws on a status it cannot read", async () => {
    await expect(progress(ok({ workflowStatus: "paused" }))).rejects.toThrow(/cannot read/);
  });

  it("names the message by its workflow, as Linked API names none", async () => {
    expect(await progress(ok({ workflowStatus: "completed", completion: { actionType: "st.sendMessage", success: true } }))).toEqual({ state: "finished", value: { chat: null, messageId: "linkedapi:wf-1" } });
  });

  it("reads an action's refusal", async () => {
    const answer = ok({ workflowStatus: "completed", completion: { actionType: "st.sendConnectionRequest", success: false, error: { type: "alreadyPending", message: "m" } } });
    expect(await progress(answer, "invitation")).toMatchObject({ state: "failed", error: { kind: "definite", code: "already_invited" } });
  });

  it("calls a broken action unknown, because a write may be half done", async () => {
    const answer = ok({ workflowStatus: "failed", failure: { reason: "unexpectedError", message: "m" } });
    expect(await progress(answer)).toMatchObject({ state: "failed", error: { kind: "unknown" } });
  });

  it.each([
    ["linkedinAccountSignedOut", { code: "auth" }],
    ["subscriptionRequired", { code: "rate_limited", retryAfterMs: 3_600_000 }],
    ["limitExceeded", { code: "rate_limited", limits: "invitations" }],
    ["noteLimitExceeded", { code: "rate_limited", limits: "invitations", retryAfterMs: 86_400_000 }],
    ["requestNotAllowed", { code: "rate_limited", limits: "invitations", retryAfterMs: 3_600_000 }],
    ["alreadyConnected", { code: "already_connected" }],
    ["invitationAlreadyReceived", { code: "already_invited" }],
    ["noteTooLong", { code: "invalid_recipient" }],
    ["personNotFound", { code: "not_found" }],
    ["personLikelyChangedPublicUrl", { code: "not_found" }],
    ["workingHoursWaitExpired", { code: "rate_limited", retryAfterMs: 3_600_000 }],
    ["invalidWorkflow", { code: "rejected" }],
  ])("reads %s on an invitation", async (type, expected) => {
    const answer = ok({ workflowStatus: "failed", failure: { reason: type, message: "m" } });
    expect(await progress(answer, "invitation")).toMatchObject({ state: "failed", error: { kind: "definite", ...expected } });
  });

  it("holds the account, not the invitations, on a message's limit", async () => {
    expect(await progress(ok({ workflowStatus: "failed", failure: { reason: "limitExceeded", message: "m" } }), "message")).toMatchObject({ error: { limits: "account" } });
  });

  it("tells a limit from nobody to message", async () => {
    const limit = ok({ workflowStatus: "completed", completion: { success: false, error: { type: "messagingNotAllowed", message: "Weekly limit reached" } } });
    const stranger = ok({ workflowStatus: "completed", completion: { success: false, error: { type: "messagingNotAllowed", message: "Not connected" } } });
    expect(await progress(limit)).toMatchObject({ error: { code: "rate_limited" } });
    expect(await progress(stranger)).toMatchObject({ error: { code: "not_first_degree" } });
  });

  it("holds a search alone when the search is what LinkedIn refused", async () => {
    expect(await progress(ok({ workflowStatus: "failed", failure: { reason: "searchingNotAllowed", message: "m" } }), "search")).toMatchObject({ error: { code: "rate_limited", limits: "invitations" } });
    expect(await progress(ok({ workflowStatus: "failed", failure: { reason: "noSalesNavigator", message: "m" } }), "search")).toMatchObject({ error: { kind: "definite", code: "rejected" } });
    expect(await progress(ok({ workflowStatus: "failed", failure: { reason: "noSalesNavigator", message: "m" } }), "lookup")).toMatchObject({ error: { code: "insufficient_privileges" } });
  });

  it("reads a person from a lookup", async () => {
    const data = { name: "Ada B Lovelace", publicUrl: "https://www.linkedin.com/in/ada", hashedUrl: "https://www.linkedin.com/in/ACoAAAda", headline: "CTO", location: "London", avatarUrl: "https://x/a.png", urn: "urn:li:member:7", viewerState: { connectionDegree: "2nd" } };
    const read = await progress(ok({ workflowStatus: "completed", completion: { actionType: "st.openPersonPage", success: true, data } }), "lookup");
    expect(read).toMatchObject({ state: "finished", value: { member: "ACoAAAda", publicSlug: "ada", firstName: "Ada", lastName: "B Lovelace", memberUrn: "urn:li:member:7", networkDistance: "second", isPremium: null } });
    expect((read as { value: GatewayProfile }).value).not.toHaveProperty("lookAgain");
  });

  it("follows a Sales Navigator hash with a classic lookup, once", async () => {
    const data = { publicUrl: "https://www.linkedin.com/in/ada", hashedUrl: "https://www.linkedin.com/in/SInQBmjJ015eLr8" };
    expect(await progress(ok({ workflowStatus: "completed", completion: { actionType: "nv.openPersonPage", success: true, data } }), "lookup")).toEqual({ state: "finished", value: { lookAgain: "ada" } });
    // A classic lookup that still names no member ends here, or it would loop.
    expect(await progress(ok({ workflowStatus: "completed", completion: { actionType: "st.openPersonPage", success: true, data } }), "lookup")).toMatchObject({ state: "failed", error: { kind: "definite", code: "not_found" } });
  });

  it("reads people from a search, with no next page", async () => {
    const data = [{ name: "A", publicUrl: "https://www.linkedin.com/in/a", hashedUrl: "https://www.linkedin.com/in/ACoAAa", position: "CEO", location: "NY" }, { name: "B", hashedUrl: "https://www.linkedin.com/in/ACoAAb" }, { name: "nobody" }];
    const read = (await progress(ok({ workflowStatus: "completed", completion: { success: true, data } }), "search")) as { value: SearchPage };
    expect(read.value.nextCursor).toBeNull();
    expect(read.value.items.map((i) => i.identifier)).toEqual(["a", "ACoAAb"]);
    expect(read.value.items[0]).toMatchObject({ headline: "CEO", location: "NY" });
  });
});

describe("cancelling", () => {
  const cancel = (answer: Answer) => gatewayWith({ "DELETE /workflows/wf-1": answer }).gateway.operations.cancel({ account: "acct", operation: "wf-1" });

  it("says cancelled only when Linked API does", async () => {
    expect(await cancel(ok({ cancelled: true }))).toBe("cancelled");
    expect(await cancel(ok({ cancelled: false }))).toBe("already_finished");
  });

  it("reads a 400 as too late, and throws on anything that says nothing", async () => {
    expect(await cancel(refused("invalidRequestPayload", 400))).toBe("already_finished");
    await expect(cancel(refused("tooManyRequests", 429))).rejects.toThrow();
    await expect(cancel(refused("unexpectedError", 400))).rejects.toThrow();
    await expect(cancel({ status: 503, body: {} })).rejects.toThrow();
  });
});

describe("an unknown outcome", () => {
  it("never claims an invitation is out without looking", async () => {
    const { gateway, calls } = gatewayWith({});
    expect(await gateway.invitationStatus()).toBe("none");
    expect(calls).toHaveLength(0);
  });

  const find = (messages: unknown[]) => {
    const made = gatewayWith({ "POST /inbox/poll": ok({ messages }) });
    return { ...made, found: made.gateway.findSentMessage({ account: "acct", to: { chat: "member:ACoAAx", member: "ACoAAx", slug: null }, text: "Hello  there", since: new Date("2026-11-05T10:00:30Z"), sendKey: "s" }) };
  };

  it("finds our own message by its text, whatever its spacing", async () => {
    const { found, calls } = find([{ id: "m1", sender: "us", text: "Hello there", time: "2026-11-05T10:00:00Z" }]);
    expect(await found).toEqual({ messageId: "m1" });
    expect(calls.find((c) => c.path === "/inbox/poll")?.body).toMatchObject({ personUrl: "https://www.linkedin.com/in/ACoAAx", since: "2026-11-05T10:00:00.000Z" });
  });

  // Null would resend it, and a late capture would make that a second message.
  it("asks a person when it is not there, never null", async () => {
    expect(await find([{ id: "m1", sender: "them", text: "Hello there" }]).found).toBe("ask_a_person");
    expect(await find([]).found).toBe("ask_a_person");
  });
});

describe("accounts", () => {
  it("keeps one per profile, active first, then the newest sign-in", () => {
    const rows = [
      { id: "old", url: "https://www.linkedin.com/in/ada", status: "reconnection_required", connectedAt: "2026-11-02T00:00:00Z" },
      { id: "new", url: "https://www.linkedin.com/in/ada", status: "active", connectedAt: "2026-11-01T00:00:00Z" },
      { id: "b1", url: "https://www.linkedin.com/in/bo", status: "active", connectedAt: "2026-11-01T00:00:00Z" },
      { id: "b2", url: "https://www.linkedin.com/in/bo", status: "active", connectedAt: "2026-11-03T00:00:00Z" },
      { id: "nourl", status: "active" },
    ];
    expect(preferredAccounts(rows).map((r) => r.id)).toEqual(["new", "b2"]);
  });

  it("calls anything but active disconnected", async () => {
    const { gateway } = gatewayWith({
      "POST /admin/accounts.getAll": ok({
        accounts: [
          { id: "a", url: "https://www.linkedin.com/in/a", status: "active", name: "A" },
          { id: "f", url: "https://www.linkedin.com/in/f", status: "frozen" },
          { id: "n", url: "https://www.linkedin.com/in/n", status: "somethingNew" },
        ],
      }),
    });
    expect((await gateway.listAccounts()).map((a) => [a.ref, a.status])).toEqual([
      ["a", "connected"],
      ["f", "disconnected"],
      ["n", "disconnected"],
    ]);
  });

  it("says nothing about Premium, so a sync leaves the account's setting", async () => {
    const { gateway } = gatewayWith({});
    expect(await gateway.getOwnProfile("acct")).toMatchObject({ member: "acct", publicSlug: "owner", firstName: "Jo", isPremium: null });
  });

  it("turns the vendor's own limits off on a link, and says why a seat stops one", async () => {
    const { gateway, calls } = gatewayWith({ "POST /admin/accounts.createConnectionSession": ok({ sessionId: "s1", connectionLink: "https://app.linkedapi.io/connection/s1" }) });
    const link = await gateway.createConnectLink({ successRedirectUrl: "http://localhost:3000", failureRedirectUrl: "http://localhost:3000", reconnectAccount: null });
    expect(link).toEqual({ url: "https://app.linkedapi.io/connection/s1", account: "s1" });
    expect(calls[0].body).toEqual({ completion: { limits: { mode: "skip" } } });

    const full = gatewayWith({ "POST /admin/accounts.createConnectionSession": refused("noAvailableSeats") });
    const error = await failure(full.gateway.createConnectLink({ successRedirectUrl: "https://a", failureRedirectUrl: "https://a", reconnectAccount: null }));
    expect(error.message).toContain("no free seat");
  });

  it("reconnects by the old id and answers the session", async () => {
    const { gateway, calls } = gatewayWith({ "POST /admin/accounts.createReconnectionSession": ok({ reconnectionSessionId: "r1", reconnectionLink: "https://app.linkedapi.io/connection/r1" }) });
    expect(await gateway.createConnectLink({ successRedirectUrl: "https://a", failureRedirectUrl: "https://b", reconnectAccount: "acct" })).toEqual({ url: "https://app.linkedapi.io/connection/r1", account: "r1" });
    expect(calls[0].body).toMatchObject({ accountId: "acct", completion: { successUrl: "https://a", failureUrl: "https://b" } });
  });
});

describe("looking at one thread", () => {
  it("loads the thread, then reads what the person wrote", async () => {
    const { gateway, calls } = gatewayWith({ [SUBMIT]: started, "POST /inbox/poll": ok({ messages: [{ id: "m1", inboxMessageId: "i1", sender: "them", text: "No" }, { id: "m2", sender: "us", text: "Hi" }] }) });
    const to = { chat: null, member: "ACoAAx", slug: null };
    const since = new Date("2026-10-01T00:00:00Z");
    const check = await gateway.operations.checkThread({ account: "acct", to, since });
    expect(isSubmitted(check)).toBe(true);
    expect(calls.find((c) => c.path === "/workflows")?.body).toMatchObject({ actionType: "st.syncConversation", personUrl: "https://www.linkedin.com/in/ACoAAx" });
    const deliveries = await gateway.operations.readThread({ account: "acct", to, since });
    expect(calls.find((c) => c.path === "/inbox/poll")?.body).toMatchObject({ type: "st" });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ source: "linkedapi-poll", kind: "message", member: "ACoAAx", row: { id: "m1" } });
  });
});
