import { LinkedInGatewayError, type LinkedInInboundRead } from "../../../application/linkedin-ports";
import type { LinkedInInboundEvent } from "../../../domain/linkedin";
import { createHash } from "node:crypto";
import { gatewayErrorFrom, refusalFrom } from "./linkedapi-errors";
import type { LinkedApiClient } from "./linkedapi-http";
import { memberOf, obj, slugOf, str, type Row } from "./linkedapi-rows";

/*
 * Reads what Linked API has captured about an account: `/inbox/poll` and `/network/poll` are plain reads that touch no browser.
 * Monitoring must be switched on first, or both answer an empty success. So a read stays failed until both workflows finished,
 * which keeps the claim gate shut. An account id is new after a reconnect, and that id needs monitoring again.
 */

const SOURCE = "linkedapi-poll";
const WATCH_WAIT_MS = 60_000;
const WATCH_RETRY_MS = 10 * 60_000;
/**
 * How far before the latest item a read looks again. An item carries the time it happened, not when Linked API's sync captured
 * it, and a search can hold the queue for an hour. The ledger drops what it reads twice.
 */
const OVERLAP_MS = 24 * 3_600_000;

interface Watch {
  action: "st.syncInbox" | "st.syncNetwork";
  workflow?: string;
  on?: boolean;
  /** A workflow failed, so the next one waits until then. */
  retryAt?: string;
}

export interface LinkedApiCursor {
  /** The account id monitoring was switched on for. */
  account?: string;
  inbox?: Watch;
  network?: Watch;
  /** The latest item time each poll saw. An empty poll moves neither. */
  inboxAt?: string;
  networkAt?: string;
  run?: { startedAt: string };
}

interface Polled {
  source: typeof SOURCE;
  kind: "message" | "acceptance";
  account: string;
  row: Row;
  /** The member a look at one thread asked about, where the row's own hash is of another form. */
  member?: string | null;
}

export const isLinkedApiDelivery = (payload: unknown): payload is Polled => obj(payload).source === SOURCE;

/** A person's message read from one thread, for the same ledger as the whole inbox. */
export const threadDelivery = (account: string, row: Row, member: string | null): Polled => ({ source: SOURCE, kind: "message", account, row, member });

const step = (cursor: LinkedApiCursor): LinkedInInboundRead => ({ deliveries: [], cursor, finishedRunStartedAt: null });

/** Starts or follows one monitoring workflow. Null once it is on. A wait fails the read rather than spin through the job's share of the tick. */
async function switchOn(client: LinkedApiClient, account: string, cursor: LinkedApiCursor, key: "inbox" | "network", action: Watch["action"], now: Date): Promise<LinkedInInboundRead | null> {
  const watch = cursor[key];
  if (watch?.on) return null;
  if (!watch?.workflow) {
    const waitMs = watch?.retryAt ? Date.parse(watch.retryAt) - now.getTime() : 0;
    if (waitMs > 0) throw new LinkedInGatewayError("Linked API could not switch on monitoring. It tries again shortly.", "unknown", "unavailable", waitMs);
    const started = await client.account(account, "POST", "/workflows", { actionType: action });
    const workflow = str(started.workflowId);
    if (!workflow) throw new LinkedInGatewayError("Linked API accepted monitoring without naming the action.", "unknown", "unavailable");
    return step({ ...cursor, [key]: { action, workflow } });
  }
  const state = await client.account(account, "GET", `/workflows/${encodeURIComponent(watch.workflow)}`);
  const status = str(state.workflowStatus);
  const completion = obj(Array.isArray(state.completion) ? state.completion[0] : state.completion);
  if (status === "completed" && completion.success !== false) return step({ ...cursor, [key]: { action, on: true } });
  if (status === "completed" || status === "failed") {
    const reason = str(obj(state.failure).reason) ?? str(obj(completion.error).type) ?? "";
    const refused = reason ? refusalFrom(reason, "", null) : null;
    if (refused?.code === "auth") throw refused;
    return step({ ...cursor, [key]: { action, retryAt: new Date(now.getTime() + WATCH_RETRY_MS).toISOString() } });
  }
  throw new LinkedInGatewayError("Linked API is still switching on monitoring.", "unknown", "unavailable", WATCH_WAIT_MS);
}

const earlier = (at: string | undefined) => (at ? new Date(Date.parse(at) - OVERLAP_MS).toISOString() : undefined);

function latest(rows: Row[], field: string, held: string | undefined): string | undefined {
  let at = held ? Date.parse(held) : Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const time = Date.parse(str(row[field]) ?? "");
    if (!Number.isNaN(time) && time > at) at = time;
  }
  return Number.isFinite(at) ? new Date(at).toISOString() : held;
}

/** One step of reading an account. */
export async function readLinkedApiInbound(client: LinkedApiClient, account: string, stored: unknown, now: Date): Promise<LinkedInInboundRead> {
  try {
    const held = obj(stored) as LinkedApiCursor;
    // The times stay across a reconnect, because the ledger drops repeats and each account row keeps its leads.
    const cursor: LinkedApiCursor = held.account === account ? held : { account, inboxAt: held.inboxAt, networkAt: held.networkAt };
    const setup = (await switchOn(client, account, cursor, "inbox", "st.syncInbox", now)) ?? (await switchOn(client, account, cursor, "network", "st.syncNetwork", now));
    if (setup) return setup;

    if (!cursor.run) {
      const since = earlier(cursor.inboxAt);
      const polled = await client.account(account, "POST", "/inbox/poll", { type: "st", ...(since ? { since } : {}) });
      const rows = (Array.isArray(polled.messages) ? polled.messages : []).map(obj);
      const deliveries: Polled[] = rows.filter((row) => row.sender === "them").map((row) => ({ source: SOURCE, kind: "message", account, row }));
      return { deliveries, cursor: { ...cursor, inboxAt: latest(rows, "time", cursor.inboxAt), run: { startedAt: now.toISOString() } }, finishedRunStartedAt: null };
    }

    const since = earlier(cursor.networkAt);
    const polled = await client.account(account, "POST", "/network/poll", since ? { since } : {});
    const rows = (Array.isArray(polled.events) ? polled.events : []).map(obj);
    const deliveries: Polled[] = rows.filter((row) => row.type === "connectionAccepted" || row.type === "connectionAdded").map((row) => ({ source: SOURCE, kind: "acceptance", account, row }));
    const finished: LinkedApiCursor = { ...cursor, networkAt: latest(rows, "detectedAt", cursor.networkAt) };
    delete finished.run;
    return { deliveries, cursor: finished, finishedRunStartedAt: new Date(cursor.run.startedAt) };
  } catch (error) {
    throw gatewayErrorFrom(error);
  }
}

/** A polled row as the event the store acts on. Null when it does not say who the person is. */
export function parseLinkedApiDelivery(payload: Polled): LinkedInInboundEvent | null {
  const { row, account } = payload;
  if (payload.kind === "acceptance") {
    const member = memberOf(row.personUrl);
    const memberUrn = str(row.personUrn);
    const slug = slugOf(row.personUrl);
    if (!member && !memberUrn && !slug) return null;
    return { type: "connection_accepted", account, member, memberUrn, slug, name: null, profileUrl: str(row.personUrl) };
  }
  const member = memberOf(row.personHashedUrl) ?? payload.member ?? null;
  const sentAt = Date.parse(str(row.time) ?? "");
  if (!member || !str(row.id) || Number.isNaN(sentAt)) return null;
  // One message has one id in the inbox and another in a read of its thread, and may have no inbox id yet. What it says, who said it and when name it in both.
  const messageId = createHash("sha256").update(`${member}|${new Date(sentAt).toISOString()}|${typeof row.text === "string" ? row.text : ""}`).digest("hex").slice(0, 40);
  return {
    type: "message_received",
    account,
    chat: str(row.threadId),
    messageId,
    text: typeof row.text === "string" ? row.text : "",
    fromAccountOwner: false,
    counterparty: member,
    counterpartyName: null,
    counterpartyProfileUrl: str(row.personPublicUrl),
    sentAt: new Date(sentAt).toISOString(),
  };
}

/** The name of a delivery this app acts on and could not read. It stays where a person sees it. */
export function unreadableLinkedApiDelivery(payload: Polled): string | null {
  return parseLinkedApiDelivery(payload) ? null : payload.kind === "message" ? "message_received" : "new_relation";
}

const acceptanceName = (row: Row) => `${str(row.personUrn) ?? String(str(row.personUrl) ?? "").toLowerCase().replace(/\/+$/, "")}:${str(row.detectedAt) ?? ""}`;

/** Reads overlap, so an unreadable row counts once. */
export function unreadableLinkedApiKey(payload: Polled, organizationId: string): string | null {
  const id = str(payload.row.id);
  return id ? `linkedapi:unreadable:v1:${organizationId}:${payload.account}:${id}` : null;
}

/** The ledger key. The organization is part of it because the ledger is unique across tenants. An acceptance's person and time name it. */
export function linkedApiEventKey(event: LinkedInInboundEvent, organizationId: string, payload: Polled): string | null {
  if (event.type === "message_received") return event.messageId ? `linkedapi:inbox:v1:${organizationId}:${event.account}:${event.messageId}` : null;
  return `linkedapi:network:v1:${organizationId}:${event.account}:${acceptanceName(payload.row)}`;
}
