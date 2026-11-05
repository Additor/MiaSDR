import { describe, expect, it } from "vitest";
import type { LinkedInGatewayError } from "../../../../application/linkedin-ports";
import { GtmClient } from "../gtm-http";
import { gtmEventKey, isGtmDelivery, parseGtmDelivery, readGtmInbound, unreadableGtmDelivery, unreadableGtmKey, type GtmCursor } from "../gtm-inbound";

const NOW = new Date("2026-11-05T10:00:00Z");
const ACCOUNT = "ln_ac_1";

const page = (rows: unknown[], next: string | null = null) => ({ success: true, items: rows.map((item) => ({ item, included: {} })), pagination: { next_cursor: next, has_more: next !== null } });
const accountPage = (over: Record<string, unknown> = {}, browser = "idle") => ({ success: true, items: [{ item: { sid: ACCOUNT, status: "active", ...over }, included: { antidetect_browser: { status: browser } } }], pagination: { next_cursor: null } });
const run = (sync_type: string, over: Record<string, unknown> = {}) => ({ sync_type, status: "completed", started_at: "2026-11-05T09:30:00Z", finished_at: "2026-11-05T09:40:00Z", wait_reason: null, ...over });
const runs = (...rows: unknown[]) => page(rows.length ? rows : [run("conversations"), run("connection_requests", { started_at: "2026-11-05T09:00:00Z" })]);

/** Answers by path, in order per path. */
function client(answers: Record<string, unknown[]>) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = String(url).replace("https://app.gtm-api.com/linkedin/v4/api/", "");
    calls.push({ path, body: JSON.parse(String(init.body)) });
    const next = answers[path]?.shift();
    if (next === undefined) throw new Error(`no answer for ${path}`);
    return new Response(JSON.stringify(next));
  }) as unknown as typeof fetch;
  return { gtm: new GtmClient({ apiKey: "k", fetch: fetcher }), calls };
}

const ACCOUNTS = "linkedin-accounts/search";
const RUNS = "linkedin-account-sync-runs/search";
const MESSAGES = "linkedin-messages/search";
const REQUESTS = "linkedin-connection-requests/search";

/** Runs a read to its end and collects what it delivered. */
async function readAll(answers: Record<string, unknown[]>, stored: unknown = {}) {
  const { gtm, calls } = client(answers);
  const deliveries: unknown[] = [];
  let cursor = stored;
  for (let step = 0; step < 10; step++) {
    const read = await readGtmInbound(gtm, ACCOUNT, cursor, NOW);
    deliveries.push(...read.deliveries);
    cursor = read.cursor;
    if (read.finishedRunStartedAt) return { deliveries, cursor: cursor as GtmCursor, calls, finishedAt: read.finishedRunStartedAt };
  }
  throw new Error("the read never finished");
}

const healthy = (messages: unknown[] = [page([])], requests: unknown[] = [page([])]) => ({ [ACCOUNTS]: [accountPage()], [RUNS]: [runs()], [MESSAGES]: messages, [REQUESTS]: requests });
const refusal = async (answers: Record<string, unknown[]>, stored: unknown = {}) => (await readGtmInbound(client(answers).gtm, ACCOUNT, stored, NOW).then(() => null, (error: unknown) => error)) as LinkedInGatewayError;
const inboxRow = { sid: "ln_ms_1", message_hash: "hash-1", ln_id: "ACoAAlead11", ln_member_id: "11", nickname: "lead", text: "Stop please", sent_at: "2026-11-05T09:50:00Z", type: "inbox", linkedin_type: "message" };

describe("reading gtm-api's store", () => {
  it("floors a first read at its start, so what the first sync loaded stops nobody", async () => {
    const { cursor, calls } = await readAll(healthy());
    expect(cursor.floor).toBe(NOW.toISOString());
    const messages = calls.find((call) => call.path === MESSAGES);
    expect(messages?.body.filter).toMatchObject({ linkedin_account_sid: { eq: ACCOUNT }, type: { eq: "inbox" }, sent_at: { gte: NOW.toISOString() } });
    expect((messages?.body.filter as Record<string, unknown>).created_at).toBeUndefined();
  });

  it("keeps the floor on later reads", async () => {
    const { cursor } = await readAll(healthy());
    const { calls } = await readAll(healthy(), cursor);
    expect((calls.find((call) => call.path === MESSAGES)?.body.filter as Record<string, unknown>).sent_at).toEqual({ gte: NOW.toISOString() });
  });

  it("starts a new account sid from where the old one stopped, so a reply written meanwhile still stops outreach", async () => {
    const { cursor, calls } = await readAll(healthy(), { account: "ln_ac_old", floor: "2020-01-01T00:00:00.000Z", messagesSyncedAt: "2026-11-01T00:00:00.000Z" });
    expect(cursor).toMatchObject({ account: ACCOUNT, floor: "2026-10-31T23:00:00.000Z" });
    const filter = calls.find((call) => call.path === MESSAGES)?.body.filter as Record<string, unknown>;
    expect(filter.sent_at).toEqual({ gte: "2026-10-31T23:00:00.000Z" });
    expect(filter.created_at).toBeUndefined();
  });

  it("keeps the first floor on a new sid when the old one never finished a read", async () => {
    const { cursor } = await readAll(healthy(), { account: "ln_ac_old", floor: "2026-11-04T00:00:00.000Z" });
    expect(cursor.floor).toBe("2026-11-04T00:00:00.000Z");
  });

  it("moves the cursor to the sync run's start, not to this read's time, so a message stored late stays ahead of it", async () => {
    const { cursor } = await readAll(healthy());
    expect(cursor).toMatchObject({ messagesSyncedAt: "2026-11-05T09:30:00Z", acceptancesSyncedAt: "2026-11-05T09:00:00Z" });
    const { calls } = await readAll(healthy(), cursor);
    expect((calls.find((call) => call.path === MESSAGES)?.body.filter as Record<string, unknown>).created_at).toEqual({ gte: "2026-11-05T08:30:00.000Z" });
    expect((calls.find((call) => call.path === REQUESTS)?.body.filter as Record<string, unknown>).deleted_at).toEqual({ gte: NOW.toISOString() });
  });

  it("does not move the cursor when no newer sync finished, across a closed window", async () => {
    const stored = { account: ACCOUNT, floor: "2026-11-01T00:00:00.000Z", messagesSyncedAt: "2026-11-05T09:30:00Z", acceptancesSyncedAt: "2026-11-05T09:00:00Z" };
    const { cursor } = await readAll(healthy(), stored);
    expect(cursor.messagesSyncedAt).toBe("2026-11-05T09:30:00Z");
  });

  it("pages messages and acceptances, then finishes at this read's start", async () => {
    const { deliveries, finishedAt, cursor } = await readAll(healthy([page([inboxRow], "m2"), page([{ ...inboxRow, sid: "ln_ms_2", message_hash: "hash-2" }])], [page([{ sid: "req", ln_id: "ACoAAlead22" }], "r2"), page([])]));
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every(isGtmDelivery)).toBe(true);
    expect(finishedAt).toEqual(NOW);
    expect(cursor.run).toBeUndefined();
  });

  it("leaves system rows and connection notes out, and takes any other type", async () => {
    const { calls } = await readAll(healthy());
    expect((calls.find((call) => call.path === MESSAGES)?.body.filter as Record<string, unknown>).linkedin_type).toEqual({ nin: ["system", "connection_note"] });
  });

  it("drops a Message Ad, which names nobody", async () => {
    const { deliveries } = await readAll(healthy([page([{ sid: "ad", ln_id: null, ln_member_id: null, text: "Buy" }])]));
    expect(deliveries).toEqual([]);
  });

  it("delivers a row with only a numeric id, to be held for a person", async () => {
    const { deliveries } = await readAll(healthy([page([{ ...inboxRow, ln_id: null }])]));
    expect(deliveries).toHaveLength(1);
    expect(unreadableGtmDelivery(deliveries[0] as never)).toBe("message_received");
  });

  it("fails on a list answer with no rows, which closes the claim gate", async () => {
    expect(await refusal({ [ACCOUNTS]: [{ success: true }] })).toMatchObject({ kind: "unknown" });
    await expect(readAll({ ...healthy(), [MESSAGES]: [{ success: true }] })).rejects.toMatchObject({ kind: "unknown" });
  });

  it("disconnects an account that is gone or signed out", async () => {
    expect(await refusal({ [ACCOUNTS]: [page([])] })).toMatchObject({ kind: "definite", code: "auth" });
    expect(await refusal({ [ACCOUNTS]: [accountPage({}, "login_issue")] })).toMatchObject({ kind: "definite", code: "auth" });
    expect(await refusal({ [ACCOUNTS]: [accountPage({ status: "subscription_required" })] })).toMatchObject({ kind: "definite", code: "auth" });
  });

  it.each(["limit:daily", "browser:login_issue"])("fails while the sync is parked for %s", async (wait_reason) => {
    const answers = { [ACCOUNTS]: [accountPage()], [RUNS]: [runs(run("conversations", { status: "pending", wait_reason }), run("conversations"), run("connection_requests"))] };
    expect(await refusal(answers)).toMatchObject({ kind: "definite", code: "unavailable" });
  });

  it("does not fail on a wait reason a finished run still carries", async () => {
    const { finishedAt } = await readAll({ ...healthy(), [RUNS]: [runs(run("conversations", { wait_reason: "limit:daily" }), run("connection_requests"))] });
    expect(finishedAt).toEqual(NOW);
  });

  it("does not fail for a closed sync window on its own", async () => {
    const { finishedAt } = await readAll({ ...healthy(), [RUNS]: [runs(run("conversations", { status: "pending", wait_reason: "schedule:closed" }), run("conversations"), run("connection_requests"))] });
    expect(finishedAt).toEqual(NOW);
  });

  it("fails when the inbox last synced over 25 hours ago, and accepts a daily sync", async () => {
    const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
    const answers = (hoursAgo: number) => ({ ...healthy(), [RUNS]: [runs(run("conversations", { finished_at: at(hoursAgo) }), run("connection_requests"))] });
    expect(await refusal(answers(26))).toMatchObject({ kind: "definite", code: "unavailable" });
    expect((await readAll(answers(24))).finishedAt).toEqual(NOW);
  });

  it("fails before a first sync has finished", async () => {
    expect(await refusal({ [ACCOUNTS]: [accountPage()], [RUNS]: [page([])] })).toMatchObject({ kind: "definite", code: "unavailable" });
    expect(await refusal({ [ACCOUNTS]: [accountPage()], [RUNS]: [runs(run("conversations"))] })).toMatchObject({ kind: "definite", code: "unavailable" });
  });

  it("keeps the invitations cursor when frequent inbox runs push the last invitations run off the page", async () => {
    const stored = { account: ACCOUNT, floor: "2026-11-01T00:00:00.000Z", messagesSyncedAt: "2026-11-05T09:00:00Z", acceptancesSyncedAt: "2026-11-05T01:00:00Z" };
    const { cursor } = await readAll({ ...healthy(), [RUNS]: [runs(run("conversations"))] }, stored);
    expect(cursor).toMatchObject({ messagesSyncedAt: "2026-11-05T09:30:00Z", acceptancesSyncedAt: "2026-11-05T01:00:00Z" });
  });

  it("skips a finished run whose start does not read as a time, so it cannot stay in the cursor", async () => {
    const answers = { [ACCOUNTS]: [accountPage()], [RUNS]: [runs(run("conversations", { started_at: "soon" }), run("connection_requests"))] };
    expect(await refusal(answers)).toMatchObject({ kind: "definite", code: "unavailable" });
  });

  it("starts a stopped read over once its page cursor may have expired", async () => {
    const stored = { account: ACCOUNT, floor: "2026-11-01T00:00:00.000Z", run: { startedAt: "2026-11-04T00:00:00.000Z", phase: "acceptances", page: "old", messagesSyncedAt: "x", acceptancesSyncedAt: "y" } };
    const { gtm, calls } = client(healthy());
    await readGtmInbound(gtm, ACCOUNT, stored, NOW);
    expect(calls.map((call) => call.path)).toEqual([ACCOUNTS, RUNS, MESSAGES]);
  });
});

describe("gtm-api deliveries", () => {
  const delivery = (row: Record<string, unknown>, kind: "message" | "acceptance" = "message") => ({ source: "gtmapi-poll" as const, kind, account: ACCOUNT, row });

  it("reads a reply by person with no chat, so a group thread cannot become this person's chat", () => {
    expect(parseGtmDelivery(delivery({ ...inboxRow, linkedin_conversation_sid: "ln_cv_group" }))).toEqual({
      type: "message_received",
      account: ACCOUNT,
      chat: null,
      messageId: "hash-1",
      text: "Stop please",
      fromAccountOwner: false,
      counterparty: "ACoAAlead11",
      counterpartyName: null,
      counterpartyProfileUrl: "https://www.linkedin.com/in/lead",
      sentAt: "2026-11-05T09:50:00.000Z",
    });
  });

  it("still reads a deleted message, which stops the sequence", () => {
    expect(parseGtmDelivery(delivery({ ...inboxRow, text: "", is_deleted: true }))).toMatchObject({ type: "message_received", text: "", counterparty: "ACoAAlead11" });
  });

  it("falls back to the sid when a row has no message hash", () => {
    expect(parseGtmDelivery(delivery({ ...inboxRow, message_hash: null }))).toMatchObject({ messageId: "ln_ms_1" });
  });

  it("reads an acceptance", () => {
    expect(parseGtmDelivery(delivery({ ln_id: "ACoAAlead22", nickname: "ada" }, "acceptance"))).toEqual({ type: "connection_accepted", account: ACCOUNT, member: "ACoAAlead22", name: null, profileUrl: "https://www.linkedin.com/in/ada" });
  });

  it("holds a row with no member id or no date, with a key so a repeat read adds no second row", () => {
    const noMember = delivery({ ...inboxRow, ln_id: "11" });
    expect(parseGtmDelivery(noMember)).toBeNull();
    expect(unreadableGtmDelivery(noMember)).toBe("message_received");
    expect(unreadableGtmKey(noMember, "org")).toBe(`gtmapi:unreadable:v1:org:${ACCOUNT}:ln_ms_1`);
    expect(unreadableGtmDelivery(delivery({ ...inboxRow, sent_at: null }))).toBe("message_received");
    expect(unreadableGtmDelivery(delivery({ sid: "r" }, "acceptance"))).toBe("new_relation");
  });

  it("keys the ledger by organization, account and message", () => {
    const event = parseGtmDelivery(delivery(inboxRow));
    expect(gtmEventKey(event as never, "org")).toBe(`gtmapi:message_received:v1:org:${ACCOUNT}:hash-1`);
    expect(gtmEventKey({ type: "connection_accepted", account: ACCOUNT, member: "m", name: null, profileUrl: null }, "org")).toBe(`gtmapi:new_relation:v1:org:${ACCOUNT}:m`);
  });
});
