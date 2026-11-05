import { describe, expect, it } from "vitest";
import { edgesEventKey, isEdgesDelivery, parseEdgesDelivery, readEdgesInbound, unreadableEdgesDelivery, type EdgesCursor } from "../edges-inbound";
import { EdgesClient, EdgesRequestError } from "../edges-http";

const now = new Date("2026-10-14T10:00:00Z");
const ME = 111;
const LEAD = "ACoAAlead";
const participant = { linkedin_profile_id: 222, sales_navigator_profile_id: LEAD, linkedin_profile_url: "https://www.linkedin.com/in/ada", first_name: "Ada" };

type Answer = { body: unknown; nextCursor?: string | null } | Error;

function client(answers: Record<string, Answer[]>) {
  const calls: string[] = [];
  const fake = {
    action: async (slug: string) => {
      calls.push(slug);
      const next = answers[slug]?.shift();
      if (!next) throw new Error("no answer for " + slug);
      if (next instanceof Error) throw next;
      return { body: next.body, nextCursor: next.nextCursor ?? null };
    },
  };
  return { client: fake as unknown as EdgesClient, calls };
}

const ready: EdgesCursor = { me: String(ME), inboxSince: "2026-10-14T09:00:00.000Z", inboxSeen: [], networkSeen: ["333"] };

/** Runs steps until a read finishes. */
async function fullRead(answers: Record<string, Answer[]>, start: EdgesCursor) {
  const c = client(answers);
  let cursor: unknown = start;
  const deliveries: unknown[] = [];
  for (let i = 0; i < 30; i++) {
    const read = await readEdgesInbound(c.client, "uid", cursor, now);
    deliveries.push(...read.deliveries);
    cursor = read.cursor;
    if (read.finishedRunStartedAt) return { deliveries, cursor: cursor as EdgesCursor, finished: read.finishedRunStartedAt, calls: c.calls };
  }
  throw new Error("the read did not finish");
}

describe("readEdgesInbound", () => {
  it("takes history as seen on the first read, and ingests none of it", async () => {
    const result = await fullRead(
      {
        "linkedin-me": [{ body: { id: ME } }],
        "linkedin-extract-conversations": [{ body: [{ linkedin_thread_id: "2-a", last_activity_at: "2026-10-14T08:00:00Z" }] }],
        "linkedin-extract-connections": [{ body: [{ linkedin_profile_id: 333 }] }],
      },
      {},
    );
    expect(result.deliveries).toEqual([]);
    expect(result.cursor).toMatchObject({ me: String(ME), inboxSince: "2026-10-14T08:00:00.000Z", inboxSeen: ["2-a"], networkSeen: ["333"] });
    expect(result.finished).toEqual(now);
  });

  it("refuses to read without knowing the account's own id, which tells its messages from a lead's", async () => {
    await expect(readEdgesInbound(client({ "linkedin-me": [{ body: {} }] }).client, "uid", {}, now)).rejects.toMatchObject({ kind: "definite" });
  });

  it("delivers a lead's new message, leaves out the account's own and what came before the cursor", async () => {
    const result = await fullRead(
      {
        "linkedin-extract-conversations": [{ body: [{ linkedin_thread_id: "2-a", last_activity_at: "2026-10-14T09:30:00Z", participants: [participant] }, { linkedin_thread_id: "2-old", last_activity_at: "2026-10-14T08:00:00Z" }] }],
        "linkedin-extract-messages": [
          {
            body: [
              { message_id: "new", delivered_at: "2026-10-14T09:30:00Z", linkedin_profile_id: 222, content: "stop please" },
              { message_id: "mine", delivered_at: "2026-10-14T09:20:00Z", linkedin_profile_id: ME, content: "hello" },
              { message_id: "old", delivered_at: "2026-10-14T08:00:00Z", linkedin_profile_id: 222, content: "before" },
            ],
          },
        ],
        "linkedin-extract-connections": [{ body: [] }],
      },
      ready,
    );
    expect(result.deliveries.map((d) => (d as { message: { message_id: string } }).message.message_id)).toEqual(["new"]);
    expect(result.cursor.inboxSince).toBe("2026-10-14T09:30:00.000Z");
    expect(result.cursor.run).toBeUndefined();
  });

  it("carries on a stopped read without moving the cursor past unread threads", async () => {
    const c = client({ "linkedin-extract-conversations": [{ body: [{ linkedin_thread_id: "2-a", last_activity_at: "2026-10-14T09:30:00Z" }, { linkedin_thread_id: "2-b", last_activity_at: "2026-10-14T09:20:00Z" }] }], "linkedin-extract-messages": [new EdgesRequestError(500, "", "down")] });
    const scanned = await readEdgesInbound(c.client, "uid", ready, now);
    const cursor = scanned.cursor as EdgesCursor;
    expect(cursor.inboxSince).toBe(ready.inboxSince);
    expect(cursor.run?.threads.map((t) => t.id)).toEqual(["2-a", "2-b"]);
    await expect(readEdgesInbound(c.client, "uid", cursor, now)).rejects.toMatchObject({ kind: "unknown" });
  });

  it("sets aside a thread Edges refuses, where a person can see it, and goes on", async () => {
    const result = await fullRead(
      {
        "linkedin-extract-conversations": [{ body: [{ linkedin_thread_id: "2-bad", last_activity_at: "2026-10-14T09:30:00Z" }] }],
        "linkedin-extract-messages": [new EdgesRequestError(400, "", "Unable to retrieve thread ID")],
        "linkedin-extract-connections": [{ body: [] }],
      },
      ready,
    );
    expect(result.deliveries).toEqual([{ source: "edges-poll", kind: "unreadable", account: "uid", thread: "2-bad" }]);
  });

  it("sets aside a thread refused for itself by LinkedIn's side too, so one thread cannot stop an account for good", async () => {
    const result = await fullRead(
      {
        "linkedin-extract-conversations": [{ body: [{ linkedin_thread_id: "2-gone", last_activity_at: "2026-10-14T09:30:00Z" }] }],
        "linkedin-extract-messages": [new EdgesRequestError(424, "NO_RESULT", "No result")],
        "linkedin-extract-connections": [{ body: [] }],
      },
      ready,
    );
    expect(result.deliveries).toEqual([{ source: "edges-poll", kind: "unreadable", account: "uid", thread: "2-gone" }]);
  });

  it("ends the read on an outage, a limit or a lost identity, which say nothing about the thread", async () => {
    const stopped = (error: EdgesRequestError) =>
      fullRead(
        {
          "linkedin-extract-conversations": [{ body: [{ linkedin_thread_id: "2-a", last_activity_at: "2026-10-14T09:30:00Z" }] }],
          "linkedin-extract-messages": [error],
        },
        ready,
      );
    await expect(stopped(new EdgesRequestError(424, "", "boom"))).rejects.toMatchObject({ kind: "unknown" });
    await expect(stopped(new EdgesRequestError(424, "LIMIT_REACHED", "m", "DAILY_LIMIT"))).rejects.toMatchObject({ code: "rate_limited" });
    await expect(stopped(new EdgesRequestError(404, "WORKSPACE_IDENTITY_404_NOT_FOUND", "gone"))).rejects.toMatchObject({ code: "auth" });
  });

  it("takes a list answer of another shape as no answer, not as an empty inbox", async () => {
    await expect(readEdgesInbound(client({ "linkedin-extract-conversations": [{ body: { error: "busy" } }] }).client, "uid", ready, now)).rejects.toMatchObject({ kind: "unknown" });
  });

  it("delivers a new message with no id, which is then held as unreadable", async () => {
    const result = await fullRead(
      {
        "linkedin-extract-conversations": [{ body: [{ linkedin_thread_id: "2-a", last_activity_at: "2026-10-14T09:30:00Z", participants: [participant] }] }],
        "linkedin-extract-messages": [{ body: [{ delivered_at: "2026-10-14T09:30:00Z", linkedin_profile_id: 222, content: "stop please" }] }],
        "linkedin-extract-connections": [{ body: [] }],
      },
      ready,
    );
    expect(result.deliveries).toHaveLength(1);
    const event = parseEdgesDelivery(result.deliveries[0] as never);
    expect(edgesEventKey(event as never, "org1")).toBeNull();
  });

  it("delivers a new message with no date, which is then held as unreadable, and keeps the account's own out", async () => {
    const result = await fullRead(
      {
        "linkedin-extract-conversations": [{ body: [{ linkedin_thread_id: "2-a", last_activity_at: "2026-10-14T09:30:00Z", participants: [participant] }] }],
        "linkedin-extract-messages": [
          {
            body: [
              { message_id: "dated", delivered_at: "2026-10-14T09:30:00Z", linkedin_profile_id: 222, content: "later" },
              { message_id: "undated", linkedin_profile_id: 222, content: "stop please" },
              { message_id: "mine", linkedin_profile_id: ME, content: "hello" },
            ],
          },
        ],
        "linkedin-extract-connections": [{ body: [] }],
      },
      ready,
    );
    expect(result.deliveries.map((d) => (d as { message: { message_id: string } }).message.message_id)).toEqual(["undated", "dated"]);
    expect(parseEdgesDelivery(result.deliveries[0] as never)).toBeNull();
    expect(unreadableEdgesDelivery(result.deliveries[0] as never)).toBe("message_received");
  });

  it("takes an empty answer as no answer, not as an empty inbox", async () => {
    await expect(readEdgesInbound(client({ "linkedin-extract-conversations": [{ body: null }] }).client, "uid", ready, now)).rejects.toMatchObject({ kind: "unknown" });
  });

  it("reports a conversation with no thread id where a person can see it, once", async () => {
    const nameless = { last_activity_at: "2026-10-14T09:30:00Z", participants: [participant] };
    const first = await fullRead({ "linkedin-extract-conversations": [{ body: [nameless] }], "linkedin-extract-connections": [{ body: [] }] }, ready);
    expect(first.deliveries).toEqual([{ source: "edges-poll", kind: "unreadable", account: "uid", thread: null }]);
    expect(first.cursor.inboxSince).toBe("2026-10-14T09:30:00.000Z");
    const again = await fullRead({ "linkedin-extract-conversations": [{ body: [nameless] }], "linkedin-extract-connections": [{ body: [] }] }, first.cursor);
    expect(again.deliveries).toEqual([]);
  });

  it("lets an ad neither end the walk nor move the cursor", async () => {
    const ad = (at: string) => ({ linkedin_thread_id: "2-ad", last_activity_at: at, sponsored: true });
    const read = (first: object) =>
      fullRead(
        {
          "linkedin-extract-conversations": [{ body: [first, { linkedin_thread_id: "2-a", last_activity_at: "2026-10-14T09:30:00Z", participants: [participant] }] }],
          "linkedin-extract-messages": [{ body: [{ message_id: "m1", delivered_at: "2026-10-14T09:30:00Z", linkedin_profile_id: 222, content: "Hi" }] }],
          "linkedin-extract-connections": [{ body: [] }],
        },
        ready,
      );
    const pinnedOld = await read(ad("2026-10-01T00:00:00Z"));
    expect(pinnedOld.deliveries).toHaveLength(1);
    expect(pinnedOld.cursor.inboxSince).toBe("2026-10-14T09:30:00.000Z");
    expect((await read(ad("2026-10-14T09:59:00Z"))).cursor.inboxSince).toBe("2026-10-14T09:30:00.000Z");
  });

  it("tells a connection with no numeric id by its ACoAA id, so its acceptance is not lost", async () => {
    const row = { connected_at: "2026-10-14T00:00:00Z", sales_navigator_profile_id: LEAD };
    const first = await fullRead({ "linkedin-extract-conversations": [{ body: [] }], "linkedin-extract-connections": [{ body: [row] }] }, ready);
    expect(first.deliveries).toHaveLength(1);
    expect(first.cursor.networkSeen).toEqual([LEAD, "333"]);
    const again = await fullRead({ "linkedin-extract-conversations": [{ body: [] }], "linkedin-extract-connections": [{ body: [row] }] }, first.cursor);
    expect(again.deliveries).toEqual([]);
  });

  it("starts over a read stopped long ago, because Edges' page cursors expire", async () => {
    const stale: EdgesCursor = { ...ready, run: { startedAt: "2026-10-13T10:00:00.000Z", phase: "network", page: "expired", threads: [], newest: null, newestThreads: [] } };
    const c = client({ "linkedin-extract-conversations": [{ body: [] }] });
    const read = await readEdgesInbound(c.client, "uid", stale, now);
    expect(c.calls).toEqual(["linkedin-extract-conversations"]);
    expect((read.cursor as EdgesCursor).run?.startedAt).toBe(now.toISOString());
  });

  it("reaches back from the last read, so a weekend without reads loses no acceptance", async () => {
    const afterWeekend: EdgesCursor = { ...ready, networkReadAt: "2026-10-09T18:00:00.000Z" };
    const result = await fullRead(
      {
        "linkedin-extract-conversations": [{ body: [] }],
        "linkedin-extract-connections": [
          { body: [{ linkedin_profile_id: 444, connected_at: "2026-10-11T00:00:00Z", sales_navigator_profile_id: LEAD }], nextCursor: "next" },
          { body: [{ linkedin_profile_id: 555, connected_at: "2026-10-09T00:00:00Z", sales_navigator_profile_id: "ACoAAfriday" }] },
        ],
      },
      afterWeekend,
    );
    expect(result.deliveries.map((d) => (d as { connection: { linkedin_profile_id: number } }).connection.linkedin_profile_id)).toEqual([444, 555]);
    expect(result.cursor.networkReadAt).toBe(now.toISOString());
  });

  it("reads connections back two days by id, because their dates hold only the day", async () => {
    const today = "2026-10-14T00:00:00Z";
    const result = await fullRead(
      {
        "linkedin-extract-conversations": [{ body: [] }],
        "linkedin-extract-connections": [
          { body: [{ linkedin_profile_id: 333, connected_at: today }, { linkedin_profile_id: 444, connected_at: today, sales_navigator_profile_id: LEAD }], nextCursor: "next" },
          { body: [{ linkedin_profile_id: 555, connected_at: "2026-10-01T00:00:00Z", sales_navigator_profile_id: "ACoAAolder" }], nextCursor: "ignored" },
        ],
      },
      ready,
    );
    expect(result.deliveries.map((d) => (d as { connection: { linkedin_profile_id: number } }).connection.linkedin_profile_id)).toEqual([444, 555]);
    expect(result.cursor.networkSeen).toEqual(["555", "444", "333"]);
    expect(result.calls.filter((slug) => slug === "linkedin-extract-connections")).toHaveLength(2);
  });
});

describe("parseEdgesDelivery", () => {
  const message = (fields: Record<string, unknown>) => ({ source: "edges-poll" as const, kind: "message" as const, account: "uid", thread: "2-a", participants: [participant], message: { message_id: "m1", delivered_at: "2026-10-14T09:30:00Z", content: "Hi", ...fields } });

  it("reads a message as a lead's, naming the person by ACoAA id", () => {
    expect(isEdgesDelivery(message({}))).toBe(true);
    expect(isEdgesDelivery({ event: "message_received" })).toBe(false);
    expect(parseEdgesDelivery(message({ linkedin_profile_id: 222 }))).toMatchObject({ type: "message_received", account: "uid", chat: "2-a", messageId: "m1", fromAccountOwner: false, counterparty: LEAD, counterpartyProfileUrl: "https://www.linkedin.com/in/ada" });
  });

  it("does not take a group thread for the person's chat, since a send goes to the person", () => {
    const group = { ...message({ linkedin_profile_id: 222 }), participants: [participant, { linkedin_profile_id: 333, sales_navigator_profile_id: "ACoAAother" }] };
    expect(parseEdgesDelivery(group)).toMatchObject({ chat: null, counterparty: LEAD });
  });

  it("reads a JSON-quoted date", () => {
    expect(parseEdgesDelivery(message({ linkedin_profile_id: 222, delivered_at: '"2026-10-14T09:30:00Z"' }))).toMatchObject({ sentAt: "2026-10-14T09:30:00.000Z" });
  });

  it("holds a message with no sender or no ACoAA id as unreadable, so a stop request is not lost silently", () => {
    expect(parseEdgesDelivery(message({}))).toBeNull();
    expect(unreadableEdgesDelivery(message({}))).toBe("message_received");
    const stranger = { ...message({ linkedin_profile_id: 999 }), participants: [] };
    expect(parseEdgesDelivery(stranger)).toBeNull();
    expect(unreadableEdgesDelivery({ source: "edges-poll", kind: "unreadable", account: "uid", thread: "2-a" })).toBe("thread_unreadable");
  });

  it("reads a connection as an acceptance", () => {
    expect(parseEdgesDelivery({ source: "edges-poll", kind: "connection", account: "uid", connection: { sales_navigator_profile_id: LEAD, full_name: "Ada L", linkedin_profile_url: "https://www.linkedin.com/in/ACoAAhashedhashedhashedhashed" } })).toEqual({ type: "connection_accepted", account: "uid", member: LEAD, name: "Ada L", profileUrl: null });
  });

  it("keys events with the organization, because the ledger is unique across tenants", () => {
    expect(edgesEventKey({ type: "message_received", account: "uid", chat: null, messageId: "m1", text: "", fromAccountOwner: false, counterparty: LEAD }, "org1")).toBe("edges:message_received:v1:org1:uid:m1");
    expect(edgesEventKey({ type: "connection_accepted", account: "uid", member: LEAD, name: null, profileUrl: null }, "org1")).toBe(`edges:new_relation:v1:org1:uid:${LEAD}`);
  });
});
