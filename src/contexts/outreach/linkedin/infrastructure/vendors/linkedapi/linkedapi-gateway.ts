import { LinkedInGatewayError, type GatewayAccount, type GatewayProfile, type LinkedInGateway, type LinkedInGatewayOperations, type LinkedInRecipient, type NetworkDistance, type OperationProgress, type OperationValues, type SearchItem, type SearchPage, type SubmittedOperation } from "../../../application/linkedin-ports";
import type { OpenOperationKind } from "../../../domain/linkedin-operations";
import { adminRefusal, gatewayErrorFrom, workflowFailure } from "./linkedapi-errors";
import { LinkedApiClient, LinkedApiRequestError, type LinkedApiAccountRow, type LinkedApiClientOptions } from "./linkedapi-http";
import { threadDelivery } from "./linkedapi-inbound";
import { lookupUrlOf, memberOf, minuteOf, obj, personUrlOf, slugOf, splitName, str, threadOf, type Row } from "./linkedapi-rows";

const MAX_NOTE = 300;
const MAX_MESSAGE = 1900;
const CLASSIC_READ = 1000;
const SALES_NAV_READ = 2500;
/** How long new messages keep joining a thread's loaded history. It does not limit how far back the history reads. */
const THREAD_SYNC_DAYS = 30;

const DISTANCE: Record<string, NetworkDistance> = { "1st": "first", "2nd": "second", "3rd": "third", "3rd+": "out_of_network", FIRST_DEGREE: "first", SECOND_DEGREE: "second", THIRD_DEGREE: "third", OUT_OF_NETWORK: "out_of_network" };

const isSalesNav = (url: string) => /\/sales\//i.test(url);

/** One account per profile: a reconnect lists the new id beside the old. Active first, then the newest sign-in. A row with no URL cannot be matched to an account here, and would add a second one. */
export function preferredAccounts(rows: LinkedApiAccountRow[]): LinkedApiAccountRow[] {
  const best = new Map<string, LinkedApiAccountRow>();
  const rank = (row: LinkedApiAccountRow) => (row.status === "active" ? 1e15 : 0) + (Date.parse(row.connectedAt ?? "") || 0);
  for (const row of rows) {
    const slug = slugOf(row.url);
    if (!slug) continue;
    const held = best.get(slug);
    if (!held || rank(row) > rank(held)) best.set(slug, row);
  }
  return [...best.values()];
}

function accountFrom(row: LinkedApiAccountRow): GatewayAccount {
  // `frozen` and `reconnection_required` cannot act, and neither can a status added after this was written.
  return { ref: row.id, linkedinId: row.id, name: str(row.name), username: slugOf(row.url), status: row.status === "active" ? "connected" : "disconnected" };
}

function searchItem(raw: unknown): SearchItem | null {
  const row = obj(raw);
  const slug = slugOf(row.publicUrl);
  const identifier = slug ?? memberOf(row.hashedUrl) ?? str(row.hashedUrl);
  if (!identifier) return null;
  return {
    identifier,
    profileUrl: str(row.publicUrl) ?? str(row.hashedUrl),
    name: str(row.name),
    headline: str(row.headline) ?? str(row.position),
    location: str(row.location),
    networkDistance: str(obj(row.viewerState).connectionDegree),
    raw: row,
  };
}

function lookupValue(completion: Row): OperationValues["lookup"] {
  const data = obj(completion.data);
  const member = memberOf(data.hashedUrl);
  if (member) {
    return {
      member,
      publicSlug: slugOf(data.publicUrl),
      ...splitName(data.name),
      headline: str(data.headline),
      location: str(data.location),
      pictureUrl: str(data.avatarUrl),
      networkDistance: DISTANCE[str(obj(data.viewerState).connectionDegree) ?? ""] ?? "unknown",
      isPremium: null,
      memberUrn: str(data.urn),
    };
  }
  // Sales Navigator's hash is of another surface. A classic lookup of the public slug names the member.
  const slug = slugOf(data.publicUrl);
  if (slug && completion.actionType === "nv.openPersonPage") return { lookAgain: slug };
  throw new LinkedInGatewayError("Linked API gave no LinkedIn member id for this person, so nothing can be sent to them.", "definite", "not_found");
}

function valueOf<K extends OpenOperationKind>(kind: K, completion: Row, operation: string): OperationValues[K] {
  switch (kind) {
    case "invitation":
      return { invitationId: null } as OperationValues[K];
    case "message":
      // Linked API names no message, and a message row needs an id that is this send's alone.
      return { chat: null, messageId: `linkedapi:${operation}` } as OperationValues[K];
    case "lookup":
      return lookupValue(completion) as OperationValues[K];
    case "search": {
      const rows = Array.isArray(completion.data) ? completion.data : [];
      const page: SearchPage = { items: rows.map(searchItem).filter((item) => item !== null), nextCursor: null, totalEstimate: null };
      return page as OperationValues[K];
    }
    default:
      return null as OperationValues[K];
  }
}

/**
 * LinkedIn through Linked API. Each action is a workflow in a cloud browser that answers later, so a send here answers
 * `{ operation }` and `linkedin.settle-operations` reads the outcome. There is no idempotency key. `findSentMessage` and
 * `invitationStatus` say why nothing resends on a guess.
 */
export class LinkedApiGateway implements LinkedInGateway {
  readonly client: LinkedApiClient;

  constructor(options: LinkedApiClientOptions) {
    this.client = new LinkedApiClient(options);
  }

  private async submit(account: string, kind: OpenOperationKind, workflow: Row): Promise<SubmittedOperation> {
    try {
      const started = await this.client.account(account, "POST", "/workflows", workflow);
      const operation = str(started.workflowId);
      // A success with no id is a queued action nobody can follow.
      if (!operation) throw new LinkedInGatewayError("Linked API accepted the action without naming it.", "unknown", "unavailable");
      return { operation };
    } catch (error) {
      throw gatewayErrorFrom(error, kind);
    }
  }

  async verify(): Promise<void> {
    await this.client.admin("subscription.getStatus").catch((error: unknown) => {
      throw gatewayErrorFrom(error);
    });
  }

  async listAccounts(): Promise<GatewayAccount[]> {
    try {
      return preferredAccounts(await this.client.listAccounts(true)).map(accountFrom);
    } catch (error) {
      throw gatewayErrorFrom(error);
    }
  }

  /** From the listing, so a sync costs one call. It has no Premium flag, so the account keeps what a person set. */
  async getOwnProfile(account: string): Promise<GatewayProfile> {
    try {
      const row = (await this.client.listAccounts()).find((item) => item.id === account) ?? (await this.client.listAccounts(true)).find((item) => item.id === account);
      if (!row) throw new LinkedInGatewayError("Linked API lists no such account.", "definite", "rejected");
      return { member: row.id, publicSlug: slugOf(row.url), ...splitName(row.name), headline: str(row.headline), location: null, pictureUrl: str(row.avatarUrl), networkDistance: "unknown", isPremium: null };
    } catch (error) {
      throw gatewayErrorFrom(error);
    }
  }

  async getProfile(input: { account: string; identifier: string; linkedinApi?: "sales_navigator" | "recruiter" }): Promise<SubmittedOperation> {
    if (input.linkedinApi === "recruiter") throw new LinkedInGatewayError("Linked API has no Recruiter lookup.", "definite", "insufficient_privileges");
    if (input.linkedinApi === "sales_navigator") return this.submit(input.account, "lookup", { actionType: "nv.openPersonPage", personHashedUrl: `https://www.linkedin.com/in/${input.identifier}`, basicInfo: true });
    const personUrl = lookupUrlOf(input.identifier);
    if (!personUrl) throw new LinkedInGatewayError("Linked API needs a LinkedIn profile URL or member id.", "definite", "invalid_recipient");
    return this.submit(input.account, "lookup", { actionType: "st.openPersonPage", personUrl, basicInfo: true });
  }

  async sendInvitation(input: { account: string; member: string; note: string | null; sendKey: string }): Promise<SubmittedOperation> {
    if (input.note && input.note.length > MAX_NOTE) throw new LinkedInGatewayError(`The invitation note is ${input.note.length} characters; Linked API allows ${MAX_NOTE}.`, "definite", "invalid_recipient");
    return this.submit(input.account, "invitation", { actionType: "st.sendConnectionRequest", personUrl: `https://www.linkedin.com/in/${input.member}`, ...(input.note?.trim() ? { note: input.note } : {}) });
  }

  /**
   * Answers without looking, because a real check is a workflow of its own behind the account's queue. "none" leads to a retry
   * after the grace period, and LinkedIn answers a repeat as `alreadyPending`, which counts as sent.
   */
  async invitationStatus(): Promise<"pending" | "accepted" | "none"> {
    return "none";
  }

  async sendMessage(input: { account: string; to: LinkedInRecipient; text: string; sendKey: string; unlessRepliedAfter: Date | null }): Promise<SubmittedOperation> {
    if (input.text.length > MAX_MESSAGE) throw new LinkedInGatewayError(`The message is ${input.text.length} characters; Linked API sends at most ${MAX_MESSAGE}.`, "definite", "invalid_recipient");
    const thread = threadOf(input.to);
    const personUrl = personUrlOf(input.to);
    if (!thread && !personUrl) throw new LinkedInGatewayError("No LinkedIn chat, member or profile is known for this conversation.", "definite", "invalid_recipient");
    return this.submit(input.account, "message", { actionType: "st.sendMessage", ...(thread ? { threadId: thread } : { personUrl }), text: input.text });
  }

  /** Not finding it says nothing, since how late Linked API captures a message has no stated bound. Null would resend it. */
  async findSentMessage(input: { account: string; to: LinkedInRecipient; text: string; since: Date; sendKey: string }): Promise<{ messageId: string | null } | "ask_a_person"> {
    const personUrl = personUrlOf(input.to);
    const thread = threadOf(input.to);
    if (!personUrl && !thread) return "ask_a_person";
    const norm = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
    try {
      const polled = await this.client.account(input.account, "POST", "/inbox/poll", { ...(personUrl ? { personUrl } : { threadId: thread }), type: "st", since: minuteOf(input.since).toISOString() });
      const rows = (Array.isArray(polled.messages) ? polled.messages : []).map(obj);
      const found = rows.find((row) => row.sender === "us" && norm(row.text) === norm(input.text));
      return found ? { messageId: str(found.id) } : "ask_a_person";
    } catch (error) {
      throw gatewayErrorFrom(error);
    }
  }

  /** One workflow reads the whole search. It has no cursor, so `cursor` stays unused. */
  searchPeople(input: { account: string; searchUrl: string; cursor: string | null; limit: number }): Promise<SubmittedOperation> {
    const url = input.searchUrl.trim();
    return this.submit(input.account, "search", { actionType: isSalesNav(url) ? "nv.searchPeople" : "st.searchPeople", customSearchUrl: url, limit: Math.max(1, Math.floor(input.limit)) });
  }

  /** Limits stay off at Linked API, so a default there cannot refuse what MiaSDR's own limits allow. */
  async createConnectLink(input: { successRedirectUrl: string; failureRedirectUrl: string; reconnectAccount: string | null }): Promise<{ url: string; account: string }> {
    const https = input.successRedirectUrl.startsWith("https://");
    const completion = { limits: { mode: "skip" }, ...(https ? { successUrl: input.successRedirectUrl, failureUrl: input.failureRedirectUrl } : {}) };
    try {
      this.client.forgetListing();
      if (input.reconnectAccount) {
        const session = await this.client.admin("accounts.createReconnectionSession", { accountId: input.reconnectAccount, completion });
        return { url: String(session.reconnectionLink), account: String(session.reconnectionSessionId) };
      }
      const session = await this.client.admin("accounts.createConnectionSession", { completion });
      return { url: String(session.connectionLink), account: String(session.sessionId) };
    } catch (error) {
      throw adminRefusal(error) ?? gatewayErrorFrom(error);
    }
  }

  readonly operations: LinkedInGatewayOperations = {
    progress: async <K extends OpenOperationKind>({ account, operation, kind }: { account: string; operation: string; kind: K }): Promise<OperationProgress<K>> => {
      const workflow = await this.client.account(account, "GET", `/workflows/${encodeURIComponent(operation)}`);
      const status = str(workflow.workflowStatus);
      if (status === "pending" || status === "running") return { state: "waiting", held: workflow.pendingReason === "outsideWorkingHours", started: status === "running" };
      if (status === "failed") {
        const failure = obj(workflow.failure);
        return { state: "failed", error: workflowFailure(str(failure.reason) ?? "", str(failure.message) ?? "", kind) };
      }
      if (status !== "completed") throw new Error(`Linked API answered a workflow status this cannot read: ${status ?? "none"}.`);
      const completion = obj(Array.isArray(workflow.completion) ? workflow.completion[0] : workflow.completion);
      if (completion.success === false) {
        const refused = obj(completion.error);
        return { state: "failed", error: workflowFailure(str(refused.type) ?? "", str(refused.message) ?? "", kind) };
      }
      try {
        return { state: "finished", value: valueOf(kind, completion, operation) };
      } catch (error) {
        return { state: "failed", error: gatewayErrorFrom(error, kind) };
      }
    },

    cancel: async ({ account, operation }) => {
      try {
        const answer = await this.client.account(account, "DELETE", `/workflows/${encodeURIComponent(operation)}`);
        return answer.cancelled === true ? "cancelled" : "already_finished";
      } catch (error) {
        // A 400 is a workflow past stopping, or one Linked API does not know. The next read tells which. `unexpectedError` is a 400 too, and says neither.
        if (error instanceof LinkedApiRequestError && error.status === 400 && error.type !== "unexpectedError") return "already_finished";
        throw error;
      }
    },

    maxSearchRead: (searchUrl) => (isSalesNav(searchUrl) ? SALES_NAV_READ : CLASSIC_READ),

    checkThread: ({ account, to }) => {
      const personUrl = personUrlOf(to);
      if (!personUrl) throw new LinkedInGatewayError("No LinkedIn member or profile is known for this lead.", "definite", "invalid_recipient");
      return this.submit(account, "reply_check", { actionType: "st.syncConversation", personUrl, days: THREAD_SYNC_DAYS });
    },

    readThread: async ({ account, to, since }) => {
      const personUrl = personUrlOf(to);
      if (!personUrl) return [];
      const polled = await this.client.account(account, "POST", "/inbox/poll", { personUrl, type: "st", since: minuteOf(since).toISOString() });
      const rows = (Array.isArray(polled.messages) ? polled.messages : []).map(obj);
      return rows.filter((row) => row.sender === "them").map((row) => threadDelivery(account, row, to.member));
    },
  };
}
