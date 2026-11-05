import { LinkedInGatewayError, type LinkedInInboundRead } from "../../../application/linkedin-ports";
import type { LinkedInInboundEvent } from "../../../domain/linkedin";
import { gatewayErrorFrom } from "./edges-errors";
import type { EdgesClient } from "./edges-http";
import { EdgesRequestError } from "./edges-http";
import { acoaaOf, edgesTime, firstOf, fullName, listOf, memberIdOf, obj, publicProfileUrl, rows, str, type Json } from "./edges-people";

/*
 * Edges has no webhook for messages, so an account's inbox and connections are read in steps. Each step is one API call, and
 * its results are recorded before the cursor moves, so a stopped read carries on where it was and a repeat is a duplicate.
 *
 * Conversations come newest first by `last_activity_at`, and `participants` leaves out the account. An account's own messages
 * carry its numeric `linkedin_profile_id`. `connected_at` holds only the day, so connections are told apart by id.
 */

const SOURCE = "edges-poll";
/** Connection order inside one day is not known, so a read goes back this far before the last read and tells new ones by id. */
const NETWORK_LOOKBACK_MS = 2 * 86_400_000;
const NETWORK_SEEN_MAX = 500;
/** Edges' page cursors expire within about a day, so a read stopped this long ago starts over. Nothing is lost: the inbox cursor moves only when a read finishes. */
const RUN_MAX_AGE_MS = 12 * 3_600_000;

interface PendingThread {
  id: string;
  participants: Json[];
}

interface Run {
  startedAt: string;
  phase: "conversations" | "threads" | "network";
  page: string | null;
  threads: PendingThread[];
  /** The newest activity seen, and the threads at exactly that time. Becomes the cursor once all of them are read. */
  newest: string | null;
  newestThreads: string[];
}

export interface EdgesCursor {
  /** The account's numeric member id: what its own messages carry. */
  me?: string;
  inboxSince?: string;
  inboxSeen?: string[];
  networkSeen?: string[];
  /** When the last finished read started. A read of connections reaches back from here, past any gap in the reads (a weekend, an outage). */
  networkReadAt?: string;
  run?: Run;
}

function cursorOf(value: unknown): EdgesCursor {
  return obj(value) as EdgesCursor;
}

interface PolledMessage {
  source: typeof SOURCE;
  kind: "message";
  account: string;
  thread: string;
  participants: Json[];
  message: Json;
}
interface PolledConnection {
  source: typeof SOURCE;
  kind: "connection";
  account: string;
  connection: Json;
}
interface PolledUnreadable {
  source: typeof SOURCE;
  kind: "unreadable";
  account: string;
  /** Null: the conversation came with no thread id. */
  thread: string | null;
}
type Polled = PolledMessage | PolledConnection | PolledUnreadable;

export const isEdgesDelivery = (payload: unknown): payload is Polled => obj(payload).source === SOURCE;

function currentRun(cursor: EdgesCursor, now: Date): Run {
  if (cursor.run && now.getTime() - Date.parse(cursor.run.startedAt) < RUN_MAX_AGE_MS) return cursor.run;
  return { startedAt: now.toISOString(), phase: "conversations", page: null, threads: [], newest: null, newestThreads: [] };
}

/** One step of reading an account. */
export async function readEdgesInbound(client: EdgesClient, account: string, stored: unknown, now: Date): Promise<LinkedInInboundRead> {
  const cursor = cursorOf(stored);
  try {
    if (!cursor.me) return await readMe(client, account, cursor);
    if (!cursor.inboxSince || !cursor.networkSeen) return await readFirst(client, account, cursor, now);
    const run = currentRun(cursor, now);
    if (run.phase === "conversations") return await readConversations(client, account, cursor, run);
    if (run.phase === "threads") return await readThread(client, account, cursor, run);
    return await readNetwork(client, account, cursor, run);
  } catch (error) {
    throw error instanceof LinkedInGatewayError ? error : gatewayErrorFrom(error);
  }
}

const step = (cursor: EdgesCursor, deliveries: unknown[] = []): LinkedInInboundRead => ({ deliveries, cursor, finishedRunStartedAt: null });

/** A page of conversations without LinkedIn's ads. An ad is never a lead's, and its time and place in the list say nothing about the rest. */
const conversationsOf = (body: unknown) => listOf(body).filter((conversation) => conversation.sponsored !== true);

/** What tells connections apart: the numeric id, or the ACoAA id of a row without one. */
const connectionKey = (row: Json) => memberIdOf(row.linkedin_profile_id) ?? acoaaOf(row.sales_navigator_profile_id);

async function readMe(client: EdgesClient, account: string, cursor: EdgesCursor): Promise<LinkedInInboundRead> {
  const { body } = await client.action("linkedin-me", { identity: account });
  const me = memberIdOf(firstOf(body).id);
  // Without it, the account's own messages cannot be told from a lead's.
  if (!me) throw new LinkedInGatewayError("Edges did not name this account's LinkedIn id.", "definite", "rejected");
  return step({ ...cursor, me });
}

/** What was there before the first read is history. Nothing goes out before it finishes, so no acceptance or reply of ours can be in it. */
async function readFirst(client: EdgesClient, account: string, cursor: EdgesCursor, now: Date): Promise<LinkedInInboundRead> {
  if (!cursor.inboxSince) {
    const { body } = await client.action("linkedin-extract-conversations", { identity: account });
    const conversations = conversationsOf(body);
    const newest = latestOf(conversations);
    return step({ ...cursor, inboxSince: newest ?? now.toISOString(), inboxSeen: newest ? threadsAt(conversations, newest) : [] });
  }
  const { body } = await client.action("linkedin-extract-connections", { identity: account });
  const seen = listOf(body).flatMap((row) => connectionKey(row) ?? []);
  return { deliveries: [], cursor: { ...cursor, networkSeen: seen, networkReadAt: now.toISOString() }, finishedRunStartedAt: now };
}

function latestOf(conversations: Json[]): string | null {
  let latest: number | null = null;
  for (const conversation of conversations) {
    const at = edgesTime(conversation.last_activity_at);
    if (!Number.isNaN(at) && (latest === null || at > latest)) latest = at;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

const threadsAt = (conversations: Json[], when: string) =>
  conversations.filter((c) => edgesTime(c.last_activity_at) === Date.parse(when)).flatMap((c) => str(c.linkedin_thread_id) ?? []);

async function readConversations(client: EdgesClient, account: string, cursor: EdgesCursor, run: Run): Promise<LinkedInInboundRead> {
  const answer = await client.action("linkedin-extract-conversations", { identity: account, cursor: run.page });
  const page = conversationsOf(answer.body);
  const since = Date.parse(cursor.inboxSince as string);
  const seen = new Set(cursor.inboxSeen ?? []);
  const threads = [...run.threads];
  const unreadable: PolledUnreadable[] = [];
  let reached = false;
  for (const conversation of page) {
    const at = edgesTime(conversation.last_activity_at);
    if (at < since) {
      reached = true;
      break;
    }
    const id = str(conversation.linkedin_thread_id);
    if (!id) {
      // Nothing to read it by, and a reply may be inside, so a person sees it. One exactly at the cursor was reported already.
      if (at !== since) unreadable.push({ source: SOURCE, kind: "unreadable", account, thread: null });
      continue;
    }
    if ((at === since && seen.has(id)) || threads.some((t) => t.id === id)) continue;
    threads.push({ id, participants: rows(conversation.participants) });
  }
  const pageNewest = run.page === null ? latestOf(page) : null;
  const newest = run.newest ?? pageNewest;
  const newestThreads = run.page === null && pageNewest ? threadsAt(page, pageNewest) : run.newestThreads;
  const done = reached || !answer.nextCursor;
  return step({ ...cursor, run: { ...run, phase: done ? "threads" : "conversations", page: done ? null : answer.nextCursor, threads, newest, newestThreads } }, unreadable);
}

/** Whether Edges refused this one thread, as opposed to the account or the whole read. A limit, a lost sign-in or an outage ends the read instead. */
function refusesThread(error: unknown): boolean {
  if (!(error instanceof EdgesRequestError)) return false;
  const mapped = gatewayErrorFrom(error);
  return mapped.kind === "definite" && mapped.code !== "auth" && mapped.code !== "rate_limited" && (error.status === 400 || mapped.code === "not_found");
}

/** One page of one changed thread. A thread Edges refuses outright is set aside where a person can see it, so it cannot hold up the rest. */
async function readThread(client: EdgesClient, account: string, cursor: EdgesCursor, run: Run): Promise<LinkedInInboundRead> {
  const [thread, ...rest] = run.threads;
  if (!thread) {
    const moved = run.newest && Date.parse(run.newest) >= Date.parse(cursor.inboxSince as string);
    return step({
      ...cursor,
      ...(moved ? { inboxSince: run.newest as string, inboxSeen: run.newest === new Date(Date.parse(cursor.inboxSince as string)).toISOString() ? [...new Set([...(cursor.inboxSeen ?? []), ...run.newestThreads])] : run.newestThreads } : {}),
      run: { ...run, phase: "network", page: null },
    });
  }
  let answer: { body: unknown; nextCursor: string | null };
  try {
    answer = await client.action("linkedin-extract-messages", { identity: account, input: { linkedin_thread_url: thread.id }, cursor: run.page });
  } catch (error) {
    if (!refusesThread(error)) throw error;
    const unreadable: PolledUnreadable = { source: SOURCE, kind: "unreadable", account, thread: thread.id };
    return step({ ...cursor, run: { ...run, threads: rest, page: null } }, [unreadable]);
  }
  const since = Date.parse(cursor.inboxSince as string);
  const page = listOf(answer.body);
  const times = page.map((m) => edgesTime(m.delivered_at)).filter((t) => !Number.isNaN(t));
  // A message with no id or no date still goes on and is held as unreadable. It may be a stop request, and neither can be told from what the page gives.
  const fresh = page.filter((m) => !(edgesTime(m.delivered_at) < since) && !isOwn(m, cursor.me as string)).sort((a, b) => placeOf(a) - placeOf(b));
  const deliveries: PolledMessage[] = fresh.map((message) => ({ source: SOURCE, kind: "message", account, thread: thread.id, participants: thread.participants, message }));
  // The order of a thread's messages is not documented, so only a page entirely older than the cursor ends it early.
  const more = answer.nextCursor !== null && !(times.length > 0 && Math.max(...times) < since);
  return step({ ...cursor, run: { ...run, threads: more ? run.threads : rest, page: more ? answer.nextCursor : null } }, deliveries);
}

/** Only a sender id equal to the account's own is its own. A message with no sender id goes on and is held as unreadable. */
const isOwn = (message: Json, me: string) => memberIdOf(message.linkedin_profile_id) === me;

/** A message's place in delivery order. One with no date goes first. */
function placeOf(message: Json): number {
  const at = edgesTime(message.delivered_at);
  return Number.isNaN(at) ? 0 : at;
}

async function readNetwork(client: EdgesClient, account: string, cursor: EdgesCursor, run: Run): Promise<LinkedInInboundRead> {
  const answer = await client.action("linkedin-extract-connections", { identity: account, cursor: run.page });
  const page = listOf(answer.body);
  const seen = new Set(cursor.networkSeen ?? []);
  const fresh = page.filter((row) => {
    const key = connectionKey(row);
    return key !== null && !seen.has(key);
  });
  const deliveries: PolledConnection[] = fresh.map((connection) => ({ source: SOURCE, kind: "connection", account, connection }));
  const networkSeen = [...new Set([...fresh.flatMap((row) => connectionKey(row) ?? []), ...(cursor.networkSeen ?? [])])].slice(0, NETWORK_SEEN_MAX);
  const times = page.map((row) => edgesTime(row.connected_at)).filter((t) => !Number.isNaN(t));
  const pastLookback = times.length > 0 && Math.min(...times) < Date.parse(cursor.networkReadAt ?? run.startedAt) - NETWORK_LOOKBACK_MS;
  if (answer.nextCursor && !pastLookback) return step({ ...cursor, networkSeen, run: { ...run, page: answer.nextCursor } }, deliveries);
  const finished: EdgesCursor = { ...cursor, networkSeen, networkReadAt: run.startedAt };
  delete finished.run;
  return { deliveries, cursor: finished, finishedRunStartedAt: new Date(run.startedAt) };
}

/**
 * A polled delivery as the event the store acts on. Null when it does not name the person by ACoAA id, which every match
 * needs, or has no date: with no time to place it, it may be history, so it does not read as a new reply.
 */
export function parseEdgesDelivery(payload: Polled): LinkedInInboundEvent | null {
  if (payload.kind === "unreadable") return null;
  if (payload.kind === "connection") {
    const member = acoaaOf(payload.connection.sales_navigator_profile_id);
    if (!member) return null;
    return { type: "connection_accepted", account: payload.account, member, name: fullName(payload.connection), profileUrl: publicProfileUrl(payload.connection.linkedin_profile_url) };
  }
  const { message, participants } = payload;
  const senderId = memberIdOf(message.linkedin_profile_id);
  if (!senderId) return null;
  const participant = participants.find((p) => memberIdOf(p.linkedin_profile_id) === senderId);
  const counterparty = acoaaOf(message.sales_navigator_profile_id) ?? acoaaOf(participant?.sales_navigator_profile_id);
  if (!counterparty) return null;
  const sentAt = edgesTime(message.delivered_at);
  if (Number.isNaN(sentAt)) return null;
  return {
    type: "message_received",
    account: payload.account,
    // `participants` leaves out the account, so one is a one-to-one thread. A group thread is not this person's chat: a send goes to the person, and looking for it there would find nothing and resend.
    chat: participants.length === 1 ? payload.thread : null,
    messageId: str(message.message_id),
    text: typeof message.content === "string" ? message.content : "",
    fromAccountOwner: false,
    counterparty,
    counterpartyName: fullName(message) ?? (participant ? fullName(participant) : null),
    counterpartyProfileUrl: publicProfileUrl(participant?.linkedin_profile_url),
    sentAt: new Date(sentAt).toISOString(),
  };
}

/** The name of a delivery this app acts on and could not read. It stays where a person sees it. */
export function unreadableEdgesDelivery(payload: Polled): string | null {
  if (payload.kind === "unreadable") return "thread_unreadable";
  return parseEdgesDelivery(payload) ? null : payload.kind === "message" ? "message_received" : "new_relation";
}

/** The ledger key. The organization is part of it because the ledger is unique across tenants. */
export function edgesEventKey(event: LinkedInInboundEvent, organizationId: string): string | null {
  if (event.type === "message_received") return event.messageId ? `edges:message_received:v1:${organizationId}:${event.account}:${event.messageId}` : null;
  return `edges:new_relation:v1:${organizationId}:${event.account}:${event.member}`;
}
