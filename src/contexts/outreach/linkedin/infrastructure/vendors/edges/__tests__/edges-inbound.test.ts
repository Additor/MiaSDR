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
