import { LinkedInGatewayError, type ConnectLinkInput, type GatewayAccount, type GatewayProfile, type LinkedInGateway, type LinkedInRecipient, type SearchPage } from "../../../application/linkedin-ports";
import { linkedinSlug } from "../../../domain/linkedin";
import { gatewayErrorFrom, IDENTITY_GONE } from "./edges-errors";
import { EdgesClient, EdgesRequestError, type EdgesClientOptions } from "./edges-http";
import { acoaaOf, edgesTime, listOf, normalizedText, obj, ownProfileFrom, profileFrom, publicProfileUrl, recipientUrl, rows, searchItemFrom, str, lookupUrl } from "./edges-people";

const MAX_NOTE = 300;
const MAX_MESSAGE = 8000;
const CLASSIC_SEARCH = /^https:\/\/(?:(?:www|[a-z]{2})\.)?linkedin\.com\/search\/results\/people\/\?\S+/i;
/** Reads that decide a resend stop here and give no answer. */
const MAX_PAGES = 10;
/** An invitation made this long before the claim is an earlier one. */
const SEND_SLACK_MS = 10 * 60_000;
const CLOCK_SLACK_MS = 60_000;
const DAY_MS = 86_400_000;
/** Edges limits management calls to 2 a second on its lower plans. */
const LIST_PACE_MS = 600;

const noAnswer = (what: string) => new LinkedInGatewayError(`Too many ${what} to finish the check.`, "unknown", "unavailable");

/** A reply's chat may be a placeholder for a thread with no chat id yet. */
const threadId = (chat: string | null) => (chat && !chat.startsWith("member:") ? chat : null);

const isIdentityGone = (error: unknown) => error instanceof EdgesRequestError && error.status === 404 && error.label.startsWith(IDENTITY_GONE);
const isNotFound = (error: unknown) => error instanceof EdgesRequestError && error.status === 404;

/** LinkedIn through Edges. An account is an Edges identity, and its ref is the identity's uid. */
export class EdgesGateway implements LinkedInGateway {
  private readonly client: EdgesClient;

  constructor(options: EdgesClientOptions) {
    this.client = new EdgesClient(options);
  }

  private async attempt<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw error instanceof LinkedInGatewayError ? error : gatewayErrorFrom(error);
    }
  }

  verify(): Promise<void> {
    return this.attempt(async () => {
      await this.client.request("GET", "/workspaces");
    });
  }

  /**
   * Edges lists every identity of a workspace, connected through this app or not, so it answers only for the refs it is given.
   * `username` names who is signed in now, which is what tells a sign-in as someone else from the account's own.
   */
  listAccounts(only: string[] = []): Promise<GatewayAccount[]> {
    return this.attempt(async () => {
      const listed: GatewayAccount[] = [];
      for (const [index, ref] of only.entries()) {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, LIST_PACE_MS));
        const { status, username } = await this.integration(ref);
        // Still pending is a sign-in LinkedIn holds at a check, which is not a connected account.
        listed.push({ ref, linkedinId: null, name: null, username, status: status === "connected" ? "connected" : "disconnected" });
      }
      return listed;
    });
  }

  private async integration(uid: string): Promise<{ status: "pending" | "connected" | "failed"; username: string | null }> {
    let integration: unknown;
    try {
      integration = await this.client.request("GET", `/identities/${encodeURIComponent(uid)}/integrations/linkedin`);
    } catch (error) {
      if (isIdentityGone(error)) return { status: "failed", username: null };
      if (isNotFound(error)) return { status: "pending", username: null };
      throw error;
    }
    const answer = obj(integration);
    const raw = String(answer.status ?? "").toUpperCase();
    const url = publicProfileUrl(obj(answer.meta).url);
    return { status: raw === "VALID" || raw === "LIMIT_REACHED" ? "connected" : raw === "INVALID" ? "failed" : "pending", username: url ? linkedinSlug(url) : null };
  }

  /** Where an identity's LinkedIn sign-in stands. */
  integrationStatus(uid: string): Promise<"pending" | "connected" | "failed"> {
    return this.attempt(async () => (await this.integration(uid)).status);
  }

  /**
   * Removes an identity no account uses, even one whose sign-in worked: sync adds no accounts, so nothing here would pick it up,
   * and Edges refuses a second identity for the same profile.
   */
  removeUnusedIdentity(uid: string): Promise<void> {
    return this.attempt(async () => {
      await this.client.request("DELETE", `/identities/${encodeURIComponent(uid)}`).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    });
  }

  getOwnProfile(account: string): Promise<GatewayProfile> {
    return this.attempt(async () => {
      const { body } = await this.client.action("linkedin-me", { identity: account });
      const profile = ownProfileFrom(body);
      if (!profile) throw new LinkedInGatewayError("Edges did not name this account's LinkedIn member id.", "definite", "rejected");
      return profile;
    });
  }

  getProfile(input: { account: string; identifier: string; linkedinApi?: "sales_navigator" | "recruiter" }): Promise<GatewayProfile> {
    return this.attempt(async () => {
      if (input.linkedinApi === "recruiter") throw new LinkedInGatewayError("Edges cannot reach Recruiter members.", "definite", "insufficient_privileges");
      const url = lookupUrl(input.identifier);
      if (!url) throw new LinkedInGatewayError("Edges cannot address this person.", "definite", "invalid_recipient");
      const { body } = await this.client.action("linkedin-extract-people", { identity: input.account, input: { linkedin_profile_url: url }, parameters: { highlights: true } });
      const profile = profileFrom(body);
      if (!profile) throw new LinkedInGatewayError("Edges gave no LinkedIn member id for this person.", "definite", "not_found");
      return profile;
    });
  }

  sendInvitation(input: { account: string; member: string; note: string | null }): Promise<{ invitationId: string | null }> {
    return this.attempt(async () => {
      if (input.note && input.note.length > MAX_NOTE) throw new LinkedInGatewayError(`The invitation note is ${input.note.length} characters; Edges allows ${MAX_NOTE}.`, "definite", "invalid_recipient");
      const startedAt = Date.now();
      const { body } = await this.client.action("linkedin-connect-profile", {
        identity: input.account,
        write: true,
        input: { sales_navigator_profile_id: input.member },
        ...(input.note?.trim() ? { parameters: { message: input.note } } : {}),
      });
      const answer = obj(body);
      // No invitation will come of this, so no acceptance will either: the sequence goes on with the messages.
      if (answer.connected === true) throw new LinkedInGatewayError("Already connected.", "definite", "already_connected");
      // Live answers have come back without `pending` for invitations that went out. The newest sent invitations decide.
      if (answer.pending !== true && !(await this.invitedSince(input.account, input.member, startedAt - CLOCK_SLACK_MS))) {
        throw new LinkedInGatewayError("Edges answered the invitation without saying it is pending.", "unknown", "unavailable");
      }
      return { invitationId: null };
    });
  }

  /** Whether the first page of sent invitations holds one to `member` made since `since`. A failed read is no. */
  private async invitedSince(account: string, member: string, since: number): Promise<boolean> {
    try {
      const { body } = await this.client.action("linkedin-extract-sent-invitations", { identity: account });
      return rows(body).some((item) => item.sales_navigator_profile_id === member && !(edgesTime(item.sent_date) < since));
    } catch {
      return false;
    }
  }

  /**
   * "None" allows a second invitation, so it needs both lists read back past the claim: pending invitations past its time,
   * connections past its day (`connected_at` is midnight UTC). Anything short of that gives no answer.
   */
  invitationStatus(input: { account: string; member: string; since: Date }): Promise<"pending" | "accepted" | "none"> {
    return this.attempt(async () => {
      const invitedBefore = input.since.getTime() - SEND_SLACK_MS;
      if (await this.listHolds("linkedin-extract-sent-invitations", input, "sent_date", invitedBefore, "sent invitations")) return "pending";
      const day = Math.floor(input.since.getTime() / DAY_MS) * DAY_MS;
      if (await this.listHolds("linkedin-extract-connections", input, "connected_at", day, "connections")) return "accepted";
      return "none";
    });
  }

  private async listHolds(slug: string, input: { account: string; member: string }, dateField: string, before: number, what: string): Promise<boolean> {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer: { body: unknown; nextCursor: string | null } = await this.client.action(slug, { identity: input.account, cursor });
      const items = listOf(answer.body);
      if (items.some((item) => item.sales_navigator_profile_id === input.member)) return true;
      const times = items.map((item) => edgesTime(item[dateField])).filter((time) => !Number.isNaN(time));
      cursor = answer.nextCursor;
      if (!cursor || (times.length > 0 && Math.min(...times) < before)) return false;
    }
    throw noAnswer(what);
  }

  sendMessage(input: { account: string; to: LinkedInRecipient; text: string }): Promise<{ chat: string | null; messageId: string | null }> {
    return this.attempt(async () => {
      if (input.text.length > MAX_MESSAGE) throw new LinkedInGatewayError(`The message is ${input.text.length} characters; Edges sends at most ${MAX_MESSAGE}.`, "definite", "invalid_recipient");
      const url = recipientUrl(input.to);
      if (!url) throw new LinkedInGatewayError("Edges sends to a person, and no LinkedIn member or profile is known for this conversation.", "definite", "invalid_recipient");
      const { body } = await this.client.action("linkedin-message-profile", { identity: input.account, write: true, input: { linkedin_profile_url: url }, parameters: { message: input.text } });
      const answer = obj(body);
      const messageId = str(answer.linkedin_message_id);
      if (answer.is_sent === false || (!messageId && answer.is_sent !== true)) throw new LinkedInGatewayError("Edges answered the message without saying it was sent.", "unknown", "unavailable");
      return { chat: str(answer.linkedin_thread_id) ?? threadId(input.to.chat), messageId };
    });
  }

  /** The thread with `member` among conversations active since `since`. Null: every such conversation was read, and none is with them. */
  private async threadWith(account: string, member: string, since: number): Promise<string | null> {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer: { body: unknown; nextCursor: string | null } = await this.client.action("linkedin-extract-conversations", { identity: account, cursor });
      const conversations = listOf(answer.body);
      const found = conversations.find((c) => {
        const participants = rows(c.participants);
        return participants.length === 1 && acoaaOf(participants[0].sales_navigator_profile_id) === member;
      });
      if (found) return str(found.linkedin_thread_id);
      const oldest = conversations.at(-1);
      cursor = answer.nextCursor;
      if (!cursor || (oldest && edgesTime(oldest.last_activity_at) < since)) return null;
    }
    throw noAnswer("conversations");
  }

  /** Null leads to a resend, so it needs the thread, or the absence of one, read back past `since`. */
  findSentMessage(input: { account: string; to: LinkedInRecipient; text: string; since: Date }): Promise<{ messageId: string | null } | null> {
    return this.attempt(async () => {
      const since = input.since.getTime();
      const member = input.to.member;
      const thread = threadId(input.to.chat) ?? (member ? await this.threadWith(input.account, member, since) : null);
      if (!thread) {
        if (!member) throw new LinkedInGatewayError("No thread or member to look in.", "unknown", "unavailable");
        return null;
      }
      const wanted = normalizedText(input.text);
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const answer: { body: unknown; nextCursor: string | null } = await this.client.action("linkedin-extract-messages", { identity: input.account, input: { linkedin_thread_url: thread }, cursor });
        const messages = listOf(answer.body);
        // The port asks for the account owner's message, so the same words from the lead do not count.
        const hit = messages.find((m) => normalizedText(m.content) === wanted && edgesTime(m.delivered_at) >= since && !(member && acoaaOf(m.sales_navigator_profile_id) === member));
        if (hit) return { messageId: str(hit.message_id) };
        cursor = answer.nextCursor;
        if (!cursor) return null;
      }
      throw noAnswer("messages");
    });
  }

  searchPeople(input: { account: string; searchUrl: string; cursor: string | null }): Promise<SearchPage> {
    return this.attempt(async () => {
      if (!CLASSIC_SEARCH.test(input.searchUrl.trim())) throw new LinkedInGatewayError("Edges searches only LinkedIn's classic people search (linkedin.com/search/results/people/).", "definite", "rejected");
      const answer = await this.client.action<unknown>("linkedin-search-people", { identity: input.account, input: { linkedin_people_search_url: input.searchUrl.trim() }, cursor: input.cursor });
      return { items: listOf(answer.body).map(searchItemFrom).filter((item) => item !== null), nextCursor: answer.nextCursor, totalEstimate: null };
    });
  }

  /** A reconnect gets a fresh link for the same identity. A new account gets a new identity, which goes away if no link came of it. */
  createConnectLink(input: ConnectLinkInput): Promise<{ url: string; account: string }> {
    return this.attempt(async () => {
      if (input.reconnectAccount) return { url: await this.loginLink(input.reconnectAccount), account: input.reconnectAccount };
      const created = obj(await this.createIdentity(input.expiresAt, input.timeZone));
      const uid = str(created.uid);
      if (!uid) throw new LinkedInGatewayError("Edges created an identity without an id.", "definite", "rejected");
      try {
        return { url: str(obj(created.identity_login_links).linkedin) ?? (await this.loginLink(uid)), account: uid };
      } catch (error) {
        await this.client.request("DELETE", `/identities/${encodeURIComponent(uid)}`).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * Engagement identities read without credits, which matters for an inbox read every 10 minutes. A workspace must turn them on.
   * Edges picks the identity's address by its zone and defaults to Europe/Paris. LinkedIn notices a sign-in from far away.
   */
  private async createIdentity(now: Date, timeZone: string | null): Promise<unknown> {
    const body = (type: "engagement" | "standard") => ({ name: `MiaSDR ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`, type, ...(timeZone ? { timezone: timeZone } : {}) });
    try {
      return await this.client.request("POST", "/identities", body("engagement"));
    } catch (error) {
      if (!(error instanceof EdgesRequestError) || error.status === 0 || error.status === 401 || error.status === 429 || error.status >= 500) throw error;
      return this.client.request("POST", "/identities", body("standard"));
    }
  }

  private async loginLink(uid: string): Promise<string> {
    const link = str(obj(await this.client.request("POST", `/identities/${encodeURIComponent(uid)}/generate-login-links`)).linkedin);
    if (!link) throw new LinkedInGatewayError("Edges answered without a LinkedIn login link.", "definite", "rejected");
    return link;
  }
}
