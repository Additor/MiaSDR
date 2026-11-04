import { LinkedInGatewayError, type LinkedInInboundRead } from "../../../application/linkedin-ports";
import type { LinkedInInboundEvent } from "../../../domain/linkedin";
import { gatewayErrorFrom } from "./edges-errors";
import type { EdgesClient } from "./edges-http";
import { EdgesRequestError } from "./edges-http";
import { acoaaOf, edgesTime, firstOf, memberIdOf, obj, publicProfileUrl, rows, str, type Json } from "./edges-people";

/*
 * Edges has no webhook for messages, so an account's inbox and connections are read in steps. Each step is one API call, and
 * its results are recorded before the cursor moves, so a stopped read carries on where it was and a repeat is a duplicate.
 *
 * Conversations come newest first by `last_activity_at`, and `participants` leaves out the account. An account's own messages
 * carry its numeric `linkedin_profile_id`. `connected_at` holds only the day, so connections are told apart by id.
 */

const SOURCE = "edges-poll";
/** Connection order inside one day is not known, so a read goes back this far and tells new ones by id. */
const NETWORK_LOOKBACK_MS = 2 * 86_400_000;
const NETWORK_SEEN_MAX = 500;

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
  thread: string;
}
type Polled = PolledMessage | PolledConnection | PolledUnreadable;

export const isEdgesDelivery = (payload: unknown): payload is Polled => obj(payload).source === SOURCE;

/** One step of reading an account. */
export async function readEdgesInbound(client: EdgesClient, account: string, stored: unknown, now: Date): Promise<LinkedInInboundRead> {
  const cursor = cursorOf(stored);
  try {
    if (!cursor.me) return await readMe(client, account, cursor);
    if (!cursor.inboxSince || !cursor.networkSeen) return await readFirst(client, account, cursor, now);
    const run: Run = cursor.run ?? { startedAt: now.toISOString(), phase: "conversations", page: null, threads: [], newest: null, newestThreads: [] };
    if (run.phase === "conversations") return await readConversations(client, account, cursor, run);
    if (run.phase === "threads") return await readThread(client, account, cursor, run);
    return await readNetwork(client, account, cursor, run);
  } catch (error) {
    throw error instanceof LinkedInGatewayError ? error : gatewayErrorFrom(error);
  }
}

const step = (cursor: EdgesCursor, deliveries: unknown[] = []): LinkedInInboundRead => ({ deliveries, cursor, finishedRunStartedAt: null });

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
    const conversations = rows(body);
    const newest = latestOf(conversations);
    return step({ ...cursor, inboxSince: newest ?? now.toISOString(), inboxSeen: newest ? threadsAt(conversations, newest) : [] });
  }
  const { body } = await client.action("linkedin-extract-connections", { identity: account });
  const seen = rows(body).flatMap((row) => memberIdOf(row.linkedin_profile_id) ?? []);
  return { deliveries: [], cursor: { ...cursor, networkSeen: seen }, finishedRunStartedAt: now };
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
  const page = rows(answer.body);
  const since = Date.parse(cursor.inboxSince as string);
  const seen = new Set(cursor.inboxSeen ?? []);
  const threads = [...run.threads];
  let reached = false;
  for (const conversation of page) {
    const at = edgesTime(conversation.last_activity_at);
    if (at < since) {
      reached = true;
      break;
    }
    const id = str(conversation.linkedin_thread_id);
    if (!id || conversation.sponsored === true || (at === since && seen.has(id)) || threads.some((t) => t.id === id)) continue;
    threads.push({ id, participants: rows(conversation.participants) });
  }
  const pageNewest = run.page === null ? latestOf(page) : null;
  const newest = run.newest ?? pageNewest;
  const newestThreads = run.page === null && pageNewest ? threadsAt(page, pageNewest) : run.newestThreads;
  const done = reached || !answer.nextCursor;
  return step({ ...cursor, run: { ...run, phase: done ? "threads" : "conversations", page: done ? null : answer.nextCursor, threads, newest, newestThreads } });
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
    if (!(error instanceof EdgesRequestError) || error.status !== 400) throw error;
    const unreadable: PolledUnreadable = { source: SOURCE, kind: "unreadable", account, thread: thread.id };
    return step({ ...cursor, run: { ...run, threads: rest, page: null } }, [unreadable]);
  }
  const since = Date.parse(cursor.inboxSince as string);
  const page = rows(answer.body);
  const times = page.map((m) => edgesTime(m.delivered_at)).filter((t) => !Number.isNaN(t));
  const fresh = page.filter((m) => edgesTime(m.delivered_at) >= since && str(m.message_id) && !isOwn(m, cursor.me as string)).sort((a, b) => edgesTime(a.delivered_at) - edgesTime(b.delivered_at));
  const deliveries: PolledMessage[] = fresh.map((message) => ({ source: SOURCE, kind: "message", account, thread: thread.id, participants: thread.participants, message }));
  // The order of a thread's messages is not documented, so only a page entirely older than the cursor ends it early.
  const more = answer.nextCursor !== null && !(times.length > 0 && Math.max(...times) < since);
  return step({ ...cursor, run: { ...run, threads: more ? run.threads : rest, page: more ? answer.nextCursor : null } }, deliveries);
}

/** Only a sender id equal to the account's own is its own. A message with no sender id goes on and is held as unreadable. */
const isOwn = (message: Json, me: string) => memberIdOf(message.linkedin_profile_id) === me;

async function readNetwork(client: EdgesClient, account: string, cursor: EdgesCursor, run: Run): Promise<LinkedInInboundRead> {
  const answer = await client.action("linkedin-extract-connections", { identity: account, cursor: run.page });
  const page = rows(answer.body);
  const seen = new Set(cursor.networkSeen ?? []);
  const fresh = page.filter((row) => {
    const id = memberIdOf(row.linkedin_profile_id);
    return id !== null && !seen.has(id);
  });
  const deliveries: PolledConnection[] = fresh.map((connection) => ({ source: SOURCE, kind: "connection", account, connection }));
  const networkSeen = [...new Set([...fresh.flatMap((row) => memberIdOf(row.linkedin_profile_id) ?? []), ...(cursor.networkSeen ?? [])])].slice(0, NETWORK_SEEN_MAX);
  const times = page.map((row) => edgesTime(row.connected_at)).filter((t) => !Number.isNaN(t));
  const pastLookback = times.length > 0 && Math.min(...times) < Date.parse(run.startedAt) - NETWORK_LOOKBACK_MS;
  if (answer.nextCursor && !pastLookback) return step({ ...cursor, networkSeen, run: { ...run, page: answer.nextCursor } }, deliveries);
  const { run: _finished, ...rest } = { ...cursor, networkSeen };
  return { deliveries, cursor: rest, finishedRunStartedAt: new Date(run.startedAt) };
}

const fullName = (row: Json) => str(row.full_name) ?? ([str(row.first_name), str(row.last_name)].filter(Boolean).join(" ") || null);

/** A polled delivery as the event the store acts on. Null when it does not name the person by ACoAA id, which every match needs. */
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
  return {
    type: "message_received",
    account: payload.account,
    chat: payload.thread,
    messageId: str(message.message_id),
    text: typeof message.content === "string" ? message.content : "",
    fromAccountOwner: false,
    counterparty,
    counterpartyName: fullName(message) ?? (participant ? fullName(participant) : null),
    counterpartyProfileUrl: publicProfileUrl(participant?.linkedin_profile_url),
    sentAt: str(message.delivered_at),
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
