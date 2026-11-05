import { LinkedInGatewayError, type LinkedInInboundRead } from "../../../application/linkedin-ports";
import type { LinkedInInboundEvent } from "../../../domain/linkedin";
import { gatewayErrorFrom } from "./gtm-errors";
import type { GtmClient } from "./gtm-http";
import { accountReadiness, itemsOf, memberIdOf, obj, str, type Row } from "./gtm-rows";

/*
 * Reads what gtm-api has stored about an account: these searches spend neither a browser session nor a budget. The store is
 * only as fresh as gtm-api's sync, so a read measures that too, and fails when the sync has stalled. A failed read closes the
 * claim gate. The cursor follows the sync runs, never this app's clock, so a message stored late (after a closed sync window,
 * or a sign-out) is still ahead of it. Repeats are duplicates in the ledger.
 */

const SOURCE = "gtmapi-poll";
const PAGE_SIZE = 200;
/** How far before a run's start a read looks again, for a row stored while that run was starting. */
const OVERLAP_MS = 60 * 60_000;
/** A sync older than this is stale. The free plan syncs once a day. */
const SYNC_STALE_MS = 25 * 3_600_000;
/** A run parked for these reasons is not coming back by itself soon. A closed sync window is expected, and the age above covers it. */
const STALLED_WAIT = /^(limit|browser):/;
const RUN_MAX_AGE_MS = 12 * 3_600_000;

interface Run {
  startedAt: string;
  phase: "messages" | "acceptances";
  page: string | null;
  messagesSyncedAt: string;
  acceptancesSyncedAt: string;
}

export interface GtmCursor {
  /** The account this cursor is about. A new sid starts over, so what it loads is history. */
  account?: string;
  /** What was sent before this is history and stops nobody. */
  floor?: string;
  messagesSyncedAt?: string;
  acceptancesSyncedAt?: string;
  run?: Run;
}

interface Polled {
  source: typeof SOURCE;
  kind: "message" | "acceptance";
  account: string;
  row: Row;
}

export const isGtmDelivery = (payload: unknown): payload is Polled => obj(payload).source === SOURCE;

const signedOut = () => new LinkedInGatewayError("gtm-api says this account is gone or signed out of LinkedIn.", "definite", "auth");

/** The latest finished run of each kind that matters, or a read failure when the sync is not keeping up. */
async function syncState(client: GtmClient, account: string, now: Date): Promise<{ messagesSyncedAt: string; acceptancesSyncedAt: string }> {
  const answer = await client.read("/api/linkedin-account-sync-runs/search", {
    filter: { linkedin_account_sid: { eq: account }, sync_type: { in: ["conversations", "connection_requests"] } },
    sort: { field: "created_at", direction: "desc" },
    page_size: PAGE_SIZE,
  });
  const runs = itemsOf(answer).map(({ item }) => item);
  const latestConversations = runs.find((run) => run.sync_type === "conversations");
  const wait = str(latestConversations?.wait_reason);
  if (wait && STALLED_WAIT.test(wait)) throw new LinkedInGatewayError(`gtm-api's sync of this account is waiting: ${wait}.`, "definite", "unavailable");
  const finished = (type: string) => runs.find((run) => run.sync_type === type && run.status === "completed" && str(run.started_at));
  const messages = finished("conversations");
  const acceptances = finished("connection_requests");
  if (!messages || !acceptances) throw new LinkedInGatewayError("gtm-api has not finished syncing this account yet.", "definite", "unavailable");
  const ended = Date.parse(str(messages.finished_at) ?? "");
  if (Number.isNaN(ended) || now.getTime() - ended > SYNC_STALE_MS) throw new LinkedInGatewayError("gtm-api has not synced this account's inbox in over a day.", "definite", "unavailable");
  return { messagesSyncedAt: messages.started_at as string, acceptancesSyncedAt: acceptances.started_at as string };
}

async function startRun(client: GtmClient, account: string, cursor: GtmCursor, now: Date): Promise<Run> {
  const accounts = itemsOf(await client.read("/api/linkedin-accounts/search", { filter: { sid: { eq: account } }, include: ["antidetect_browser"], page_size: 1 }));
  if (accounts.length === 0 || accountReadiness(accounts[0].item, accounts[0].included) !== "connected") throw signedOut();
  return { startedAt: now.toISOString(), phase: "messages", page: null, ...(await syncState(client, account, now)) };
}

const earlier = (at: string) => new Date(Date.parse(at) - OVERLAP_MS).toISOString();

/** One step of reading an account. */
export async function readGtmInbound(client: GtmClient, account: string, stored: unknown, now: Date): Promise<LinkedInInboundRead> {
  try {
    const held = obj(stored) as GtmCursor;
    // Nothing goes out before the first read finishes, so no reply to us can be in what the first sync loaded.
    const cursor: GtmCursor = held.account === account && held.floor ? held : { account, floor: now.toISOString() };
    const run = cursor.run && now.getTime() - Date.parse(cursor.run.startedAt) < RUN_MAX_AGE_MS ? cursor.run : await startRun(client, account, cursor, now);
    return run.phase === "messages" ? await readMessages(client, account, cursor, run) : await readAcceptances(client, account, cursor, run);
  } catch (error) {
    throw error instanceof LinkedInGatewayError ? error : gatewayErrorFrom(error);
  }
}

const step = (cursor: GtmCursor, run: Run, deliveries: unknown[]): LinkedInInboundRead => ({ deliveries, cursor: { ...cursor, run }, finishedRunStartedAt: null });

async function readMessages(client: GtmClient, account: string, cursor: GtmCursor, run: Run): Promise<LinkedInInboundRead> {
  const floor = cursor.floor as string;
  const answer = await client.read("/api/linkedin-messages/search", {
    filter: {
      linkedin_account_sid: { eq: account },
      type: { eq: "inbox" },
      linkedin_type: { nin: ["system", "connection_note"] },
      sent_at: { gte: floor },
      ...(cursor.messagesSyncedAt ? { created_at: { gte: earlier(cursor.messagesSyncedAt) } } : {}),
    },
    sort: { field: "created_at", direction: "asc" },
    page_size: PAGE_SIZE,
    ...(run.page ? { cursor: run.page } : {}),
  });
  // A row with neither id is a Message Ad: no person to stop, and a reply can not be in it.
  const rows = itemsOf(answer).map(({ item }) => item).filter((row) => str(row.ln_id) || str(row.ln_member_id));
  const deliveries: Polled[] = rows.map((row) => ({ source: SOURCE, kind: "message", account, row }));
  const next = str(obj(answer.pagination).next_cursor);
  return step(cursor, next ? { ...run, page: next } : { ...run, phase: "acceptances", page: null }, deliveries);
}

async function readAcceptances(client: GtmClient, account: string, cursor: GtmCursor, run: Run): Promise<LinkedInInboundRead> {
  const floor = cursor.floor as string;
  const since = cursor.acceptancesSyncedAt ? earlier(cursor.acceptancesSyncedAt) : floor;
  const answer = await client.read("/api/linkedin-connection-requests/search", {
    filter: { linkedin_account_sid: { eq: account }, removal_kind: { eq: "accepted" }, deleted_at: { gte: since < floor ? floor : since } },
    sort: { field: "deleted_at", direction: "asc" },
    page_size: PAGE_SIZE,
    ...(run.page ? { cursor: run.page } : {}),
  });
  const deliveries: Polled[] = itemsOf(answer).map(({ item }) => ({ source: SOURCE, kind: "acceptance", account, row: item }));
  const next = str(obj(answer.pagination).next_cursor);
  if (next) return step(cursor, { ...run, page: next }, deliveries);
  const finished: GtmCursor = { ...cursor, messagesSyncedAt: run.messagesSyncedAt, acceptancesSyncedAt: run.acceptancesSyncedAt };
  delete finished.run;
  return { deliveries, cursor: finished, finishedRunStartedAt: new Date(run.startedAt) };
}

const profileUrl = (nickname: unknown) => {
  const slug = str(nickname);
  return slug ? `https://www.linkedin.com/in/${slug}` : null;
};

/** A polled row as the event the store acts on. Null when it does not name the person by member id, which every match needs. */
export function parseGtmDelivery(payload: Polled): LinkedInInboundEvent | null {
  const { row, account } = payload;
  const member = memberIdOf(row.ln_id);
  if (!member) return null;
  if (payload.kind === "acceptance") return { type: "connection_accepted", account, member, name: null, profileUrl: profileUrl(row.nickname) };
  const sentAt = Date.parse(str(row.sent_at) ?? "");
  if (Number.isNaN(sentAt)) return null;
  return {
    type: "message_received",
    account,
    // Always by person: a row does not say who else is in its thread, and a group thread must not become this person's chat.
    chat: null,
    messageId: str(row.message_hash) ?? str(row.sid),
    // A deleted message has no text, and it still stops the sequence.
    text: typeof row.text === "string" ? row.text : "",
    fromAccountOwner: false,
    counterparty: member,
    counterpartyName: null,
    counterpartyProfileUrl: profileUrl(row.nickname),
    sentAt: new Date(sentAt).toISOString(),
  };
}

/** The name of a delivery this app acts on and could not read. It stays where a person sees it. */
export function unreadableGtmDelivery(payload: Polled): string | null {
  return parseGtmDelivery(payload) ? null : payload.kind === "message" ? "message_received" : "new_relation";
}

/** Reads repeat, so an unreadable row counts once. */
export function unreadableGtmKey(payload: Polled, organizationId: string): string | null {
  const sid = str(payload.row.sid);
  return sid ? `gtmapi:unreadable:v1:${organizationId}:${payload.account}:${sid}` : null;
}

/** The ledger key. The organization is part of it because the ledger is unique across tenants. */
export function gtmEventKey(event: LinkedInInboundEvent, organizationId: string): string | null {
  if (event.type === "message_received") return event.messageId ? `gtmapi:message_received:v1:${organizationId}:${event.account}:${event.messageId}` : null;
  return `gtmapi:new_relation:v1:${organizationId}:${event.account}:${event.member}`;
}
