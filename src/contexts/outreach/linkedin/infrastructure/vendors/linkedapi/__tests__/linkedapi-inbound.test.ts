import { describe, expect, it } from "vitest";
import type { LinkedInInboundEvent } from "../../../../domain/linkedin";
import { LinkedApiClient } from "../linkedapi-http";
import { isLinkedApiDelivery, linkedApiEventKey, parseLinkedApiDelivery, readLinkedApiInbound, unreadableLinkedApiDelivery, unreadableLinkedApiKey, type LinkedApiCursor } from "../linkedapi-inbound";

const now = new Date("2026-11-05T12:00:00Z");
const ACCOUNT = "acct";
const READY: LinkedApiCursor = { account: ACCOUNT, inbox: { action: "st.syncInbox", on: true }, network: { action: "st.syncNetwork", on: true } };
let tag = 0;

function clientWith(routes: Record<string, unknown>) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.linkedapi.io", "");
    if (path === "/admin/accounts.getAll") return new Response(JSON.stringify({ success: true, result: { accounts: [{ id: ACCOUNT, identificationToken: "t" }, { id: "new-id", identificationToken: "t2" }] } }));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    const answer = routes[`${init?.method} ${path}`];
    if (answer === undefined) throw new Error(`no route ${init?.method} ${path}`);
    return new Response(JSON.stringify(answer));
  }) as unknown as typeof fetch;
  tag += 1;
  return { client: new LinkedApiClient({ apiKey: `inbound-${tag}`, fetch: fetcher }), calls };
}
const ok = (result: unknown) => ({ success: true, result });

describe("switching monitoring on", () => {
  it("starts each monitor, and keeps its workflow in the cursor without finishing a read", async () => {
    const { client, calls } = clientWith({ "POST /workflows": ok({ workflowId: "wf-inbox" }) });
    const read = await readLinkedApiInbound(client, ACCOUNT, null, now);
    expect(read.finishedRunStartedAt).toBeNull();
    expect(read.cursor).toMatchObject({ account: ACCOUNT, inbox: { action: "st.syncInbox", workflow: "wf-inbox" } });
    expect(calls[0].body).toEqual({ actionType: "st.syncInbox" });
  });

  it("fails the read while a monitor is still starting, so the gate stays shut and the budget is not spun", async () => {
    const { client } = clientWith({ "GET /workflows/wf-inbox": ok({ workflowStatus: "running" }) });
    await expect(readLinkedApiInbound(client, ACCOUNT, { account: ACCOUNT, inbox: { action: "st.syncInbox", workflow: "wf-inbox" } }, now)).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });

  it("moves on once it finished", async () => {
    const { client } = clientWith({ "GET /workflows/wf-inbox": ok({ workflowStatus: "completed", completion: { success: true } }) });
    const read = await readLinkedApiInbound(client, ACCOUNT, { account: ACCOUNT, inbox: { action: "st.syncInbox", workflow: "wf-inbox" } }, now);
    expect((read.cursor as LinkedApiCursor).inbox).toEqual({ action: "st.syncInbox", on: true });
  });

  it("backs off from one that failed, then starts it again", async () => {
    const { client } = clientWith({ "GET /workflows/wf-inbox": ok({ workflowStatus: "failed", failure: { reason: "unexpectedError" } }), "POST /workflows": ok({ workflowId: "wf-2" }) });
    const read = await readLinkedApiInbound(client, ACCOUNT, { account: ACCOUNT, inbox: { action: "st.syncInbox", workflow: "wf-inbox" } }, now);
    const cursor = read.cursor as LinkedApiCursor;
    expect(cursor.inbox?.workflow).toBeUndefined();
    await expect(readLinkedApiInbound(client, ACCOUNT, cursor, now)).rejects.toMatchObject({ retryAfterMs: 600_000 });
    const later = await readLinkedApiInbound(client, ACCOUNT, cursor, new Date(now.getTime() + 601_000));
    expect((later.cursor as LinkedApiCursor).inbox?.workflow).toBe("wf-2");
  });

  it("disconnects a signed-out account, rather than wait on it", async () => {
    const { client } = clientWith({ "GET /workflows/wf-inbox": ok({ workflowStatus: "failed", failure: { reason: "linkedinAccountSignedOut" } }) });
    await expect(readLinkedApiInbound(client, ACCOUNT, { account: ACCOUNT, inbox: { action: "st.syncInbox", workflow: "wf-inbox" } }, now)).rejects.toMatchObject({ kind: "definite", code: "auth" });
  });

  it("switches monitoring on again for a new id, and keeps the times", async () => {
    const { client, calls } = clientWith({ "POST /workflows": ok({ workflowId: "wf-3" }) });
    const read = await readLinkedApiInbound(client, "new-id", { ...READY, inboxAt: "2026-11-01T00:00:00.000Z" }, now);
    expect(calls[0].path).toBe("/workflows");
    expect(read.cursor).toMatchObject({ account: "new-id", inboxAt: "2026-11-01T00:00:00.000Z", inbox: { workflow: "wf-3" } });
  });
});

describe("a read", () => {
  it("reads the inbox and then the network, and finishes when both are read", async () => {
    const message = { id: "m1", sender: "them", text: "Hi", time: "2026-11-05T11:00:00Z", personHashedUrl: "https://www.linkedin.com/in/ACoAAx", threadId: "2-a" };
    const ours = { id: "m2", sender: "us", text: "Yo", time: "2026-11-05T11:30:00Z" };
    const accepted = { id: "e1", type: "connectionAccepted", personUrl: "https://www.linkedin.com/in/ada", detectedAt: "2026-11-05T11:10:00Z" };
    const received = { id: "e2", type: "connectionRequestReceived", personUrl: "https://www.linkedin.com/in/bo", detectedAt: "2026-11-05T11:20:00Z" };
    const { client, calls } = clientWith({ "POST /inbox/poll": ok({ messages: [ours, message] }), "POST /network/poll": ok({ events: [received, accepted] }) });

    const first = await readLinkedApiInbound(client, ACCOUNT, READY, now);
    expect(first.deliveries).toEqual([{ source: "linkedapi-poll", kind: "message", account: ACCOUNT, row: message }]);
    expect(first.finishedRunStartedAt).toBeNull();
    expect(first.cursor).toMatchObject({ inboxAt: "2026-11-05T11:30:00.000Z" });
    expect(calls[0].body).toEqual({ type: "st" });

    const later = new Date(now.getTime() + 5_000);
    const second = await readLinkedApiInbound(client, ACCOUNT, first.cursor, later);
    expect(second.deliveries).toHaveLength(1);
    expect(second.finishedRunStartedAt).toEqual(now);
    expect(second.cursor).toMatchObject({ networkAt: "2026-11-05T11:20:00.000Z" });
    expect((second.cursor as LinkedApiCursor).run).toBeUndefined();
  });

  it("looks a day behind the latest item, and an empty poll moves nothing", async () => {
    const { client, calls } = clientWith({ "POST /inbox/poll": ok({ messages: [] }) });
    const read = await readLinkedApiInbound(client, ACCOUNT, { ...READY, inboxAt: "2026-11-04T12:00:00.000Z" }, now);
    expect(calls[0].body).toEqual({ type: "st", since: "2026-11-03T12:00:00.000Z" });
    expect(read.cursor).toMatchObject({ inboxAt: "2026-11-04T12:00:00.000Z" });
  });
});

describe("reading a delivery", () => {
  const message = (row: Record<string, unknown>, member?: string) => ({ source: "linkedapi-poll" as const, kind: "message" as const, account: ACCOUNT, row, ...(member ? { member } : {}) });
  const acceptance = (row: Record<string, unknown>) => ({ source: "linkedapi-poll" as const, kind: "acceptance" as const, account: ACCOUNT, row });

  it("knows its own", () => {
    expect(isLinkedApiDelivery(message({}))).toBe(true);
    expect(isLinkedApiDelivery({ source: "gtmapi-poll" })).toBe(false);
  });

  it("reads a message from the person", () => {
    const event = parseLinkedApiDelivery(message({ id: "m1", threadId: "2-a", personHashedUrl: "https://www.linkedin.com/in/ACoAAx", personPublicUrl: "https://www.linkedin.com/in/ada", text: "Hi", time: "2026-11-05T11:00:00Z" }));
    expect(event).toMatchObject({ type: "message_received", chat: "2-a", counterparty: "ACoAAx", counterpartyProfileUrl: "https://www.linkedin.com/in/ada", fromAccountOwner: false });
  });

  it("gives one message one id, read from its thread or the inbox, with an inbox id or without", () => {
    const row = { personHashedUrl: "https://www.linkedin.com/in/ACoAAx", text: "Hi", time: "2026-11-05T11:00:00Z" };
    const id = (over: Record<string, unknown>) => (parseLinkedApiDelivery(message({ ...row, ...over })) as { messageId: string }).messageId;
    expect(id({ id: "thread-row", inboxMessageId: null })).toBe(id({ id: "inbox-row" }));
    expect(id({ id: "a", text: "Other" })).not.toBe(id({ id: "a" }));
  });

  it("takes the member a thread's read asked about when the row's hash is of another form", () => {
    expect(parseLinkedApiDelivery(message({ id: "m1", personHashedUrl: "https://www.linkedin.com/in/ACwAAother", time: "2026-11-05T11:00:00Z" }, "ACoAAx"))).toMatchObject({ counterparty: "ACoAAx" });
  });

  it("leaves a message that names nobody where a person sees it", () => {
    const payload = message({ id: "m1", personHashedUrl: "https://www.linkedin.com/in/ACwAAother", time: "2026-11-05T11:00:00Z" });
    expect(parseLinkedApiDelivery(payload)).toBeNull();
    expect(unreadableLinkedApiDelivery(payload)).toBe("message_received");
    expect(unreadableLinkedApiKey(payload, "org")).toBe("linkedapi:unreadable:v1:org:acct:m1");
  });

  it("reads an acceptance by whichever way it names the person", () => {
    expect(parseLinkedApiDelivery(acceptance({ personUrn: "urn:li:member:7", personUrl: "https://www.linkedin.com/in/ada" }))).toMatchObject({ type: "connection_accepted", member: null, memberUrn: "urn:li:member:7", slug: "ada" });
    expect(parseLinkedApiDelivery(acceptance({ personUrl: "https://www.linkedin.com/in/ACoAAx" }))).toMatchObject({ member: "ACoAAx", slug: null });
    expect(parseLinkedApiDelivery(acceptance({}))).toBeNull();
    expect(unreadableLinkedApiDelivery(acceptance({}))).toBe("new_relation");
  });

  it("keys a repeat alike, by tenant, and two moments of one person apart", () => {
    const row = { personUrn: "urn:li:member:7", detectedAt: "2026-11-05T11:00:00Z" };
    const event = parseLinkedApiDelivery(acceptance(row)) as LinkedInInboundEvent;
    expect(linkedApiEventKey(event, "org", acceptance(row))).toBe(linkedApiEventKey(event, "org", acceptance({ ...row, id: "e2" })));
    expect(linkedApiEventKey(event, "other", acceptance(row))).not.toBe(linkedApiEventKey(event, "org", acceptance(row)));
    expect(linkedApiEventKey(event, "org", acceptance({ ...row, detectedAt: "2026-11-06T11:00:00Z" }))).not.toBe(linkedApiEventKey(event, "org", acceptance(row)));
  });
});
