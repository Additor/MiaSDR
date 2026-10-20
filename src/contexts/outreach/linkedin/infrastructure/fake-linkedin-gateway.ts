import { linkedinSlug } from "../domain/linkedin";
import {
  LinkedInGatewayError,
  type GatewayAccount,
  type HostedAuthLinkInput,
  type GatewayProfile,
  type LinkedInGateway,
  type LinkedInGatewayProvider,
  type SearchPage,
  type WebhookRegistration,
} from "../application/linkedin-ports";

export type FakeLinkedInBehavior =
  /** The action succeeds. */
  | "ok"
  /** The provider refuses; nothing happened. */
  | { refuse: "rate_limited" | "auth" | "insufficient_privileges" | "already_connected" | "already_invited" | "invalid_recipient" | "rejected" }
  /** The call times out, but the provider did perform it. */
  | "timeout-after-accept"
  /** The call times out and nothing happened. */
  | "timeout-lost";

export type FakeProfileFailure = "auth" | "insufficient_privileges" | "not_found" | "rejected" | "invalid_recipient" | "transient";

interface FakeInvitation {
  account: string;
  member: string;
  note: string | null;
  id: string;
  accepted: boolean;
}

interface FakeMessage {
  account: string;
  chat: string;
  text: string;
  id: string;
  at: Date;
}

/** In-memory LinkedIn for tests and demos. It also serves as its own provider: one instance for every organization. */
export class FakeLinkedInGateway implements LinkedInGateway, LinkedInGatewayProvider {
  readonly invitations: FakeInvitation[] = [];
  readonly messages: FakeMessage[] = [];
  /** Every profile lookup, in order. `linkedinApi` is null for a classic lookup. */
  readonly profileCalls: Array<{ account: string; identifier: string; linkedinApi: "sales_navigator" | "recruiter" | null }> = [];
  readonly searchLog: Array<{ account: string; url: string; cursor: string | null }> = [];
  private readonly chats = new Map<string, string>();
  private counter = 0;
  private readonly instance = Math.random().toString(36).slice(2, 8);

  accounts: GatewayAccount[] = [];
  /** Slugs the fake knows. Unknown slugs fail with not_found. Missing entries are created on the fly when `autoProfiles` is true. */
  readonly profiles = new Map<string, GatewayProfile>();
  autoProfiles = true;
  /** When true, lookups and list calls fail like an outage. */
  readOutage = false;
  /** Fails a profile lookup before it looks anything up. It runs once per call, so a test can fail the classic call and
   * answer the retry differently. Live behavior (2026-10-15): an account without Sales Navigator or Recruiter scopes answers a
   * lookup that carries `linkedinApi` with `insufficient_privileges`. `auth` is a real credential failure, `transient` an
   * unknown outcome (5xx or timeout). Return null to let the lookup run. */
  profileFailure: (call: { identifier: string; linkedinApi: "sales_navigator" | "recruiter" | null }) => FakeProfileFailure | null = () => null;
  verifyError: LinkedInGatewayError | null = null;
  verifyCalls = 0;
  inviteBehavior: (member: string) => FakeLinkedInBehavior = () => "ok";
  messageBehavior: (text: string) => FakeLinkedInBehavior = () => "ok";
  /** Pages served for every search, by cursor index. Empty: `autoSearchTotal` people are made up instead. */
  searchPages: SearchPage[] = [];
  /** How a search call behaves. A refusal or timeout applies before any page is served. */
  searchBehavior: (call: { account: string; url: string; cursor: string | null }) => FakeLinkedInBehavior = () => "ok";
  /** Runs inside a search call, before it answers. Lets a test cancel or pause while a page is in flight. */
  onSearch: ((call: { account: string; url: string; cursor: string | null }) => Promise<void> | void) | null = null;
  /** Demo data: this many made-up people, ten per page, when `searchPages` is empty. */
  autoSearchTotal = 0;
  readonly hostedLinks: HostedAuthLinkInput[] = [];
  hostedLinkError: LinkedInGatewayError | null = null;
  readonly webhookRegistrations: Array<{ requestUrl: string; secret: string }> = [];
  /** Webhooks that exist at the fake provider right now. */
  readonly webhooks: Array<{ id: string; requestUrl: string; secret: string }> = [];
  /** When set, list and delete calls for webhooks fail with this error, and every hook creation fails too. */
  webhookError: LinkedInGatewayError | null = null;
  /** Name of one hook (such as `messaging:message_received`) whose creation fails. */
  failHook: string | null = null;
  removeCalls = 0;

  async forOrganization(): Promise<LinkedInGateway | null> {
    return this;
  }

  private next(prefix: string) {
    return `${prefix}-${this.instance}-${++this.counter}`;
  }

  private outage(): never {
    throw new LinkedInGatewayError("Unipile is unavailable", "unknown", "unavailable");
  }

  private gate(behavior: FakeLinkedInBehavior): "perform" | "perform-then-fail" | "skip-then-fail" {
    if (behavior === "ok") return "perform";
    if (behavior === "timeout-after-accept") return "perform-then-fail";
    if (behavior === "timeout-lost") return "skip-then-fail";
    const { refuse } = behavior;
    throw new LinkedInGatewayError(`Fake refusal: ${refuse}`, "definite", refuse);
  }

  async verify(): Promise<void> {
    this.verifyCalls += 1;
    if (this.verifyError) throw this.verifyError;
  }

  async listAccounts(): Promise<GatewayAccount[]> {
    if (this.readOutage) this.outage();
    return this.accounts;
  }

  async getOwnProfile(account: string): Promise<GatewayProfile> {
    const a = this.accounts.find((x) => x.ref === account);
    return { member: a?.linkedinId ?? account, publicSlug: a?.username ?? null, firstName: a?.name ?? null, lastName: null, headline: null, location: null, pictureUrl: null, networkDistance: "unknown", isPremium: false };
  }

  async getProfile(input: { account: string; identifier: string; linkedinApi?: "sales_navigator" | "recruiter" }): Promise<GatewayProfile> {
    this.profileCalls.push({ account: input.account, identifier: input.identifier, linkedinApi: input.linkedinApi ?? null });
    if (this.readOutage) this.outage();
    const failure = this.profileFailure({ identifier: input.identifier, linkedinApi: input.linkedinApi ?? null });
    if (failure === "auth") throw new LinkedInGatewayError("Unipile: Invalid credentials.", "definite", "auth");
    if (failure === "insufficient_privileges") throw new LinkedInGatewayError("Unipile refused the call because this LinkedIn account lacks access to the resource (This resource seems to be out of your scopes.).", "definite", "insufficient_privileges");
    if (failure === "not_found") throw new LinkedInGatewayError("Profile not found", "definite", "not_found");
    if (failure === "rejected") throw new LinkedInGatewayError("Unipile: request rejected", "definite", "rejected");
    if (failure === "invalid_recipient") throw new LinkedInGatewayError("Unipile: invalid recipient", "definite", "invalid_recipient");
    if (failure === "transient") throw new LinkedInGatewayError("Unipile is unavailable", "unknown", "unavailable");
    const slug = linkedinSlug(input.identifier) ?? input.identifier;
    const known = this.profiles.get(slug);
    if (known) return known;
    const byMember = [...this.profiles.values()].find((p) => p.member === input.identifier);
    if (byMember) return byMember;
    if (!this.autoProfiles) throw new LinkedInGatewayError("Profile not found", "definite", "not_found");
    const profile: GatewayProfile = {
      member: `ACo-${slug}`,
      publicSlug: slug,
      firstName: null,
      lastName: null,
      headline: null,
      location: null,
      pictureUrl: null,
      networkDistance: this.invitations.some((i) => i.member === `ACo-${slug}` && i.accepted) ? "first" : "third",
      isPremium: false,
    };
    return profile;
  }

  async sendInvitation(input: { account: string; member: string; note: string | null }): Promise<{ invitationId: string | null }> {
    const mode = this.gate(this.inviteBehavior(input.member));
    if (mode === "skip-then-fail") throw new LinkedInGatewayError("Request timed out", "unknown", "unavailable");
    const invitation = { account: input.account, member: input.member, note: input.note, id: this.next("inv"), accepted: false };
    this.invitations.push(invitation);
    if (mode === "perform-then-fail") throw new LinkedInGatewayError("Request timed out", "unknown", "unavailable");
    return { invitationId: invitation.id };
  }

  async invitationStatus(input: { account: string; member: string }): Promise<"pending" | "accepted" | "none"> {
    if (this.readOutage) this.outage();
    const found = this.invitations.find((i) => i.account === input.account && i.member === input.member);
    if (!found) return "none";
    return found.accepted ? "accepted" : "pending";
  }

  /** Test helper: the other person accepted. Returns the provider ids a webhook would carry. */
  accept(member: string) {
    for (const i of this.invitations) if (i.member === member) i.accepted = true;
  }

  async findChat(input: { account: string; member: string }): Promise<string | null> {
    if (this.readOutage) this.outage();
    return this.chats.get(`${input.account}:${input.member}`) ?? null;
  }

  private record(account: string, chat: string, text: string): FakeMessage {
    const message = { account, chat, text, id: this.next("msg"), at: new Date() };
    this.messages.push(message);
    return message;
  }

  async sendMessage(input: { account: string; chat: string; text: string }): Promise<{ messageId: string | null }> {
    const mode = this.gate(this.messageBehavior(input.text));
    if (mode === "skip-then-fail") throw new LinkedInGatewayError("Request timed out", "unknown", "unavailable");
    const message = this.record(input.account, input.chat, input.text);
    if (mode === "perform-then-fail") throw new LinkedInGatewayError("Request timed out", "unknown", "unavailable");
    return { messageId: message.id };
  }

  async startChat(input: { account: string; member: string; text: string }): Promise<{ chat: string | null; messageId: string | null }> {
    const mode = this.gate(this.messageBehavior(input.text));
    if (mode === "skip-then-fail") throw new LinkedInGatewayError("Request timed out", "unknown", "unavailable");
    const chat = this.chats.get(`${input.account}:${input.member}`) ?? this.next("chat");
    this.chats.set(`${input.account}:${input.member}`, chat);
    const message = this.record(input.account, chat, input.text);
    if (mode === "perform-then-fail") throw new LinkedInGatewayError("Request timed out", "unknown", "unavailable");
    return { chat, messageId: message.id };
  }

  async findSentMessage(input: { account: string; chat: string; text: string; since: Date }): Promise<{ messageId: string | null } | null> {
    if (this.readOutage) this.outage();
    const hit = this.messages.find((m) => m.account === input.account && m.chat === input.chat && m.text.trim() === input.text.trim());
    return hit ? { messageId: hit.id } : null;
  }

  async searchPeople(input: { account: string; searchUrl: string; cursor: string | null }): Promise<SearchPage> {
    const call = { account: input.account, url: input.searchUrl, cursor: input.cursor };
    this.searchLog.push(call);
    const mode = this.gate(this.searchBehavior(call));
    if (mode !== "perform") throw new LinkedInGatewayError("Request timed out", "unknown", "unavailable");
    await this.onSearch?.(call);
    const index = input.cursor ? Number(input.cursor) : 0;
    if (this.searchPages.length > 0 || this.autoSearchTotal === 0) return this.searchPages[index] ?? { items: [], nextCursor: null, totalEstimate: 0 };
    return this.generatedPage(input.searchUrl, index);
  }

  private generatedPage(url: string, index: number): SearchPage {
    const size = 10;
    const first = index * size;
    const last = Math.min(first + size, this.autoSearchTotal);
    const tag = [...url].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7).toString(36);
    const items = Array.from({ length: Math.max(0, last - first) }, (_, i) => {
      const n = first + i + 1;
      const slug = `demo-person-${tag}-${n}`;
      return {
        identifier: slug,
        profileUrl: `https://www.linkedin.com/in/${slug}`,
        name: `Demo Person ${n}`,
        headline: `Head of Growth at Demo Co ${n}`,
        location: "Berlin, Germany",
        networkDistance: "DISTANCE_2",
        raw: { demo: true, n },
      };
    });
    return { items, nextCursor: last < this.autoSearchTotal ? String(index + 1) : null, totalEstimate: this.autoSearchTotal };
  }

  async registerWebhooks(input: { requestUrl: string; secret: string }): Promise<WebhookRegistration> {
    if (this.webhookError) throw this.webhookError;
    this.deleteHooks(input.requestUrl);
    this.webhookRegistrations.push({ requestUrl: input.requestUrl, secret: input.secret });
    const hooks: WebhookRegistration["hooks"] = [];
    for (const name of ["users:new_relation", "messaging:message_received"]) {
      if (name === this.failHook) {
        hooks.push({ name, error: new LinkedInGatewayError("Unipile is unavailable", "unknown", "unavailable") });
        continue;
      }
      this.webhooks.push({ id: this.next("hook"), requestUrl: input.requestUrl, secret: input.secret });
      hooks.push({ name, error: null });
    }
    return { registered: hooks.filter((h) => h.error === null).map((h) => h.name), hooks };
  }

  async removeWebhooks(input: { requestUrl: string }): Promise<{ removed: number }> {
    this.removeCalls += 1;
    if (this.webhookError) throw this.webhookError;
    return { removed: this.deleteHooks(input.requestUrl) };
  }

  private deleteHooks(requestUrl: string): number {
    const before = this.webhooks.length;
    const keep = this.webhooks.filter((h) => h.requestUrl !== requestUrl);
    this.webhooks.splice(0, this.webhooks.length, ...keep);
    return before - keep.length;
  }

  async createHostedAuthLink(input: HostedAuthLinkInput): Promise<{ url: string }> {
    if (this.hostedLinkError) throw this.hostedLinkError;
    this.hostedLinks.push(input);
    // The fake wizard succeeds at once: the account exists for the next sync and the link is the success redirect.
    if (!input.reconnectAccount) {
      const n = this.hostedLinks.length;
      this.accounts = [...this.accounts, { ref: `hosted-${this.instance}-${n}`, linkedinId: `ACo-hosted-${this.instance}-${n}`, name: `Hosted Seller ${n}`, username: `hosted-seller-${this.instance}-${n}`, status: "connected" }];
    }
    return { url: input.successRedirectUrl };
  }
}
