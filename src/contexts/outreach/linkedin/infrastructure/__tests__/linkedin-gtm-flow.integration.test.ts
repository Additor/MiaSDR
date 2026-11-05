import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import { LinkedInGatewayError, type LinkedInEngineDeps, type LinkedInGateway, type LinkedInInboundDeps } from "../../application/linkedin-ports";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [
  { stepNumber: 1, kind: "invitation", body: "", waitDays: 0 },
  { stepNumber: 2, kind: "message", body: "Thanks", waitDays: 1 },
];

describeDb("LinkedIn accounts on gtm-api", () => {
  useTestEnv({ LINKEDIN_PROVIDER: undefined });
  const sql = testSql({ max: 6 });
  let store: typeof import("../drizzle-linkedin-store").drizzleLinkedInStore;
  let accounts: typeof import("../drizzle-linkedin-account-store").drizzleLinkedInAccountStore;
  let pollStore: typeof import("../drizzle-linkedin-inbound-read-store").drizzleLinkedInInboundPollStore;
  let engine: typeof import("../../application/send-next-linkedin");
  let poll: typeof import("../../application/poll-linkedin-inbound");
  let composition: typeof import("../linkedin-composition");
  let inbound: LinkedInInboundDeps;
  let gtm: typeof import("../vendors/gtmapi/gtm-inbound");
  let http: typeof import("../vendors/gtmapi/gtm-http");
  let replyStop: LinkedInEngineDeps["stopForReply"];
  const orgs: string[] = [];

  async function org() {
    const tag = uniqueKey();
    const [{ id }] = await sql`insert into organizations (name, slug) values ('G', ${"gtm-" + tag}) returning id`;
    orgs.push(id);
    return id as string;
  }

  async function account(organizationId: string) {
    const ref = `ln_ac_${uniqueKey()}`;
    const [{ id }] = await sql`
      insert into linkedin_accounts (organization_id, provider, provider_account_id, linkedin_id, username, status, daily_invite_limit, working_hours, inbound_read_at)
      values (${organizationId}, 'gtmapi', ${ref}, ${"ACoAAowner" + ref}, ${"owner-" + ref}, 'connected', 20, ${sql.json({ timeZone: "UTC", days: ALL_DAY } as never)}, now())
      returning id`;
    return { id: id as string, ref };
  }

  /** A lead past the invitation, due its message, on `accountId`. */
  async function connectedLead(organizationId: string, accountId: string, options: { invitedAt?: Date | null; acceptedAt?: Date | null } = {}) {
    const member = `ACoAAlead${uniqueKey().replaceAll("-", "")}`;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${organizationId}, 'linkedin', 'c', 'active', ${sql.json(STEPS as never)}) returning id`;
    const [{ id: person }] = await sql`insert into people (organization_id, linkedin_slug, first_name) values (${organizationId}, ${"lead-" + uniqueKey()}, 'Ada') returning id`;
    const [{ id: enrollment }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, next_send_at, linkedin_account_id)
      values (${organizationId}, ${campaign}, ${person}, 'linkedin', 'active', 1, now() - interval '1 minute', ${accountId}) returning id`;
    await sql`
      insert into linkedin_enrollment_details (enrollment_id, organization_id, provider_id, connection_state, accepted_at)
      values (${enrollment}, ${organizationId}, ${member}, 'connected', ${options.acceptedAt ?? null})`;
    if (options.invitedAt) {
      await sql`
        insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id, attempt, claimed_at, sent_at)
        values (${organizationId}, ${enrollment}, 1, 'linkedin', 'sent', ${accountId}, 1, ${options.invitedAt}, ${options.invitedAt})`;
    }
    return { enrollment: enrollment as string, person: person as string, member };
  }

  /** A lead waiting for a lookup or an invitation on this account. */
  async function pendingLead(organizationId: string, accountId: string, member: string | null) {
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${organizationId}, 'linkedin', 'c', 'active', ${sql.json(STEPS as never)}) returning id`;
    const slug = `lead-${uniqueKey()}`;
    const [{ id: person }] = await sql`insert into people (organization_id, linkedin_slug, first_name) values (${organizationId}, ${slug}, 'Ada') returning id`;
    const [{ id: enrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, linkedin_account_id) values (${organizationId}, ${campaign}, ${person}, 'linkedin', ${accountId}) returning id`;
    await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, profile_url, provider_id) values (${enrollment}, ${organizationId}, ${"https://www.linkedin.com/in/" + slug}, ${member})`;
    return enrollment as string;
  }

  const claim = (id: string, now = new Date()) => store.claimNext({ accountId: id, now, random: () => 0, defaultWorkingHours: () => ({ timeZone: "UTC", days: ALL_DAY }) as never });

  const engineWith = (gateway: Partial<LinkedInGateway>): LinkedInEngineDeps => ({ store, stopForReply: replyStop, gateways: { forAccount: async () => gateway as LinkedInGateway }, clock: { now: () => new Date() }, random: () => 0 });

  beforeAll(async () => {
    ({ drizzleLinkedInStore: store } = await import("../drizzle-linkedin-store"));
    ({ drizzleLinkedInAccountStore: accounts } = await import("../drizzle-linkedin-account-store"));
    ({ drizzleLinkedInInboundPollStore: pollStore } = await import("../drizzle-linkedin-inbound-read-store"));
    engine = await import("../../application/send-next-linkedin");
    poll = await import("../../application/poll-linkedin-inbound");
    composition = await import("../linkedin-composition");
    gtm = await import("../vendors/gtmapi/gtm-inbound");
    http = await import("../vendors/gtmapi/gtm-http");
    const { createDrizzleLinkedInInboundStore } = await import("../drizzle-linkedin-inbound-store");
    const { contactStop, inboxFiling } = await import("@/composition/inbox-filing");
    replyStop = (await import("../drizzle-linkedin-store")).createLinkedInReplyStop(contactStop);
    inbound = {
      store: createDrizzleLinkedInInboundStore(inboxFiling),
      clock: { now: () => new Date() },
      parse: (payload) => (gtm.isGtmDelivery(payload) ? gtm.parseGtmDelivery(payload) : null),
      unreadable: (payload) => (gtm.isGtmDelivery(payload) ? gtm.unreadableGtmDelivery(payload) : null),
      unreadableKey: (payload, organizationId) => (gtm.isGtmDelivery(payload) ? gtm.unreadableGtmKey(payload, organizationId) : null),
      eventKey: (event, organizationId) => gtm.gtmEventKey(event, organizationId),
    };
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    await sql.end();
  });

  describe("the check before a message", () => {
    it("names when outreach began, from the invitation, so a later reply counts", async () => {
      const id = await org();
      const seller = await account(id);
      const invitedAt = new Date("2026-10-01T10:00:00Z");
      await connectedLead(id, seller.id, { invitedAt, acceptedAt: new Date("2026-10-03T10:00:00Z") });
      expect(await claim(seller.id)).toMatchObject({ kind: "message", outreachStartedAt: invitedAt });
    });

    it("falls back to the acceptance for a lead already connected, whose invitation never went out", async () => {
      const id = await org();
      const seller = await account(id);
      const acceptedAt = new Date("2026-10-03T10:00:00Z");
      await connectedLead(id, seller.id, { acceptedAt });
      expect(await claim(seller.id)).toMatchObject({ kind: "message", outreachStartedAt: acceptedAt });
    });

    it("passes the send id as the key and the moment to the gateway", async () => {
      const id = await org();
      const seller = await account(id);
      const invitedAt = new Date("2026-10-01T10:00:00Z");
      await connectedLead(id, seller.id, { invitedAt });
      const seen: unknown[] = [];
      const outcome = await engine.runNextLinkedInAction(engineWith({ sendMessage: async (input) => (seen.push(input), { chat: null, messageId: "ln_ms_1" }) }), seller.id);
      expect(outcome).toMatchObject({ kind: "sent", what: "message" });
      const [send] = await sql`select id from sends where linkedin_account_id = ${seller.id} and step_number = 2`;
      expect(seen[0]).toMatchObject({ sendKey: send.id, unlessRepliedAfter: invitedAt });
    });

    it("stops all outreach to the person on a refusal, with nothing counted as sent and nothing to retry", async () => {
      const id = await org();
      const seller = await account(id);
      const lead = await connectedLead(id, seller.id, { invitedAt: new Date("2026-10-01T10:00:00Z") });
      const [{ id: otherCampaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${id}, 'email', 'e', 'active', ${sql.json([] as never)}) returning id`;
      const [{ id: elsewhere }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${id}, ${otherCampaign}, ${lead.person}, 'email', 'active') returning id`;
      const refused = new LinkedInGatewayError("The person wrote.", "definite", "replied");
      const outcome = await engine.runNextLinkedInAction(engineWith({ sendMessage: async () => Promise.reject(refused) }), seller.id);
      expect(outcome).toEqual({ kind: "blocked", reason: "replied" });
      const [enrollment] = await sql`select status, stop_reason, next_send_at from campaign_enrollments where id = ${lead.enrollment}`;
      expect(enrollment).toMatchObject({ status: "replied", stop_reason: "replied", next_send_at: null });
      const [send] = await sql`select status, attempt from sends where enrollment_id = ${lead.enrollment} and step_number = 2`;
      expect(send).toMatchObject({ status: "failed", attempt: 0 });
      expect((await sql`select status from campaign_enrollments where id = ${elsewhere}`)[0].status).toBe("replied");
      await sql`update linkedin_accounts set next_allowed_run_at = null where id = ${seller.id}`;
      expect(await claim(seller.id)).toBeNull();
    });
  });

  describe("a refusal about one person's thread", () => {
    it("holds that lead with its attempt back, and the account goes on to the next", async () => {
      const id = await org();
      const seller = await account(id);
      const held = await connectedLead(id, seller.id, { acceptedAt: new Date() });
      const busy = new LinkedInGatewayError("Busy.", "definite", "rate_limited", 3_600_000, "recipient");
      const outcome = await engine.runNextLinkedInAction(engineWith({ sendMessage: async () => Promise.reject(busy) }), seller.id);
      expect(outcome).toEqual({ kind: "blocked", reason: "recipient_held" });
      expect((await sql`select limit_reached_until from linkedin_accounts where id = ${seller.id}`)[0].limit_reached_until).toBeNull();
      expect((await sql`select status, attempt, error from sends where enrollment_id = ${held.enrollment} and step_number = 2`)[0]).toMatchObject({ status: "failed", attempt: 0, error: "Busy." });
      expect((await sql`select status, next_send_at from campaign_enrollments where id = ${held.enrollment}`)[0].status).toBe("active");

      await sql`update linkedin_accounts set next_allowed_run_at = null where id = ${seller.id}`;
      expect(await claim(seller.id)).toBeNull();
      const next = await connectedLead(id, seller.id, { acceptedAt: new Date() });
      expect(await claim(seller.id)).toMatchObject({ kind: "message", enrollmentId: next.enrollment });
    });
  });

  describe("a limit that stops invitations alone", () => {
    const limit = (ms: number) => new LinkedInGatewayError("Budget.", "definite", "rate_limited", ms, "invitations");

    it("holds invitations and lookups, gives the attempt back, and leaves messages and the account free", async () => {
      const id = await org();
      const seller = await account(id);
      const waiting = await pendingLead(id, seller.id, "ACoAAinvitee000");
      const outcome = await engine.runNextLinkedInAction(engineWith({ sendInvitation: async () => Promise.reject(limit(3_600_000)) }), seller.id);
      expect(outcome).toEqual({ kind: "paused", reason: "limit" });
      const [row] = await sql`select limit_reached_until, invites_paused_until from linkedin_accounts where id = ${seller.id}`;
      expect(row.limit_reached_until).toBeNull();
      expect(row.invites_paused_until).not.toBeNull();
      expect((await sql`select attempt from sends where enrollment_id = ${waiting}`)[0].attempt).toBe(0);

      await sql`update linkedin_accounts set next_allowed_run_at = null where id = ${seller.id}`;
      await pendingLead(id, seller.id, null);
      expect(await claim(seller.id)).toBeNull();

      await connectedLead(id, seller.id, { acceptedAt: new Date() });
      expect(await claim(seller.id)).toMatchObject({ kind: "message" });
    });

    it("holds invitations when a lookup runs out, and starts again once the time passes", async () => {
      const id = await org();
      const seller = await account(id);
      await pendingLead(id, seller.id, null);
      const outcome = await engine.runNextLinkedInAction(engineWith({ getProfile: async () => Promise.reject(limit(60_000)) }), seller.id);
      expect(outcome).toEqual({ kind: "paused", reason: "limit" });
      await sql`update linkedin_accounts set next_allowed_run_at = null, invites_paused_until = now() - interval '1 second' where id = ${seller.id}`;
      await sql`update linkedin_enrollment_details set resolve_next_attempt_at = null where organization_id = ${id}`;
      expect(await claim(seller.id)).toMatchObject({ kind: "resolve" });
    });

    it("shows the hold on the account, and a counters reset clears it", async () => {
      const id = await org();
      const seller = await account(id);
      await pendingLead(id, seller.id, "ACoAAinvitee003");
      await engine.runNextLinkedInAction(engineWith({ sendInvitation: async () => Promise.reject(limit(3_600_000)) }), seller.id);
      const listed = await accounts.list(id, new Date());
      expect(listed[0].invitesPausedUntil).not.toBeNull();
      expect(listed[0].limitReachedUntil).toBeNull();
      const { drizzleLinkedInOperationsStore } = await import("../drizzle-linkedin-operations-store");
      const outcome = await drizzleLinkedInOperationsStore.resetDailyCounters(id, new Date(), (result) => ({ organizationId: id, actorUserId: null, action: "linkedin.daily_counters_reset", entityType: "organization", meta: result }) as never);
      expect(outcome.pausesCleared).toBe(1);
      expect((await accounts.list(id, new Date()))[0].invitesPausedUntil).toBeNull();
    });

    it("leaves a limit that stops the account as it was", async () => {
      const id = await org();
      const seller = await account(id);
      await pendingLead(id, seller.id, "ACoAAinvitee001");
      const refused = new LinkedInGatewayError("Budget.", "definite", "rate_limited", 60_000);
      await engine.runNextLinkedInAction(engineWith({ sendInvitation: async () => Promise.reject(refused) }), seller.id);
      const [row] = await sql`select limit_reached_until, invites_paused_until from linkedin_accounts where id = ${seller.id}`;
      expect(row.limit_reached_until).not.toBeNull();
      expect(row.invites_paused_until).toBeNull();
    });
  });

  describe("reading replies through the same ledger", () => {
    const envelope = (rows: unknown[]) => ({ success: true, items: rows.map((item) => ({ item, included: {} })), pagination: { next_cursor: null } });

    /** A stand-in for gtm-api's store that answers the same rows on every read. */
    function storeWith(rows: unknown[], requests: unknown[] = []) {
      const now = new Date().toISOString();
      const fetcher = (async (url: string) => {
        const path = String(url).split("/api/")[1];
        if (path === "linkedin-accounts/search") return new Response(JSON.stringify({ success: true, items: [{ item: { status: "active" }, included: {} }], pagination: { next_cursor: null } }));
        if (path === "linkedin-account-sync-runs/search") {
          const run = (sync_type: string) => ({ sync_type, status: "completed", started_at: now, finished_at: now, wait_reason: null });
          return new Response(JSON.stringify(envelope([run("conversations"), run("connection_requests")])));
        }
        return new Response(JSON.stringify(envelope(path === "linkedin-messages/search" ? rows : requests)));
      }) as unknown as typeof fetch;
      return new http.GtmClient({ apiKey: "k", fetch: fetcher });
    }

    const read = (client: InstanceType<typeof http.GtmClient>) =>
      poll.pollLinkedInInbound(
        { store: pollStore, inbound, clock: { now: () => new Date() }, source: { read: ({ account: ref, cursor, now }) => gtm.readGtmInbound(client, ref, cursor, now) } },
        Date.now() + 10_000,
      );

    const row = (member: string, over: Record<string, unknown> = {}) => ({ sid: `ln_ms_${uniqueKey()}`, message_hash: `hash-${uniqueKey()}`, ln_id: member, nickname: "ada", text: "No thanks", sent_at: new Date().toISOString(), type: "inbox", linkedin_type: "message", ...over });

    it("stops the sequence on a reply, keeps the read open, and adds nothing on a repeat", async () => {
      const id = await org();
      const seller = await account(id);
      await sql`update linkedin_accounts set inbound_read_at = null where id = ${seller.id}`;
      const lead = await connectedLead(id, seller.id, { invitedAt: new Date("2026-10-01T10:00:00Z") });
      const client = storeWith([row(lead.member)]);
      const report = await read(client);
      expect(report).toMatchObject({ failed: 0, finished: 1 });
      expect((await sql`select status from campaign_enrollments where id = ${lead.enrollment}`)[0].status).toBe("replied");
      const count = async () => (await sql`select count(*)::int as n from inbound_events where organization_id = ${id}`)[0].n;
      const first = await count();
      expect(first).toBe(1);
      await sql`update linkedin_accounts set inbound_read_at = null, inbound_lease_until = null where id = ${seller.id}`;
      await read(client);
      expect(await count()).toBe(first);
    });

    it("advances an acceptance through the ledger", async () => {
      const id = await org();
      const seller = await account(id);
      await sql`update linkedin_accounts set inbound_read_at = null where id = ${seller.id}`;
      const member = "ACoAAinvitee002";
      const waiting = await pendingLead(id, seller.id, member);
      await sql`update linkedin_enrollment_details set connection_state = 'request_sent' where enrollment_id = ${waiting}`;
      await sql`update campaign_enrollments set status = 'active', current_step = 1 where id = ${waiting}`;
      await read(storeWith([], [{ sid: "req", ln_id: member, nickname: "ada", removal_kind: "accepted", deleted_at: new Date().toISOString() }]));
      expect((await sql`select connection_state from linkedin_enrollment_details where enrollment_id = ${waiting}`)[0].connection_state).toBe("connected");
    });

    it("holds an unreadable row once, however many reads see it", async () => {
      const id = await org();
      const seller = await account(id);
      await sql`update linkedin_accounts set inbound_read_at = null where id = ${seller.id}`;
      const client = storeWith([row("", { ln_id: null, ln_member_id: "11" })]);
      await read(client);
      await sql`update linkedin_accounts set inbound_read_at = null, inbound_lease_until = null where id = ${seller.id}`;
      await read(client);
      const rows = await sql`select status, event_type from inbound_events where organization_id = ${id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "failed", event_type: "message_received" });
    });

    it("closes the claim gate when a read fails on a stalled sync", async () => {
      const id = await org();
      const seller = await account(id);
      await sql`update linkedin_accounts set inbound_read_at = null where id = ${seller.id}`;
      await pendingLead(id, seller.id, null);
      const fetcher = (async (url: string) => {
        const path = String(url).split("/api/")[1];
        if (path === "linkedin-accounts/search") return new Response(JSON.stringify({ success: true, items: [{ item: { status: "active" }, included: {} }], pagination: { next_cursor: null } }));
        return new Response(JSON.stringify(envelope([{ sync_type: "conversations", status: "pending", wait_reason: "browser:login_issue" }])));
      }) as unknown as typeof fetch;
      const report = await read(new http.GtmClient({ apiKey: "k", fetch: fetcher }));
      expect(report.failed).toBe(1);
      expect(await claim(seller.id)).toBeNull();
    });
  });

  describe("connecting", () => {
    it("starts a new premium account under gtm-api's own invitation budget", async () => {
      const id = await org();
      const ref = `ln_ac_${uniqueKey()}`;
      await accounts.upsertAccounts(id, [{ ref, linkedinId: `ACoAAowner${uniqueKey()}`, name: "S", username: null, status: "connected", isPremium: true, headline: null }], "gtmapi");
      expect((await sql`select provider, daily_invite_limit from linkedin_accounts where provider_account_id = ${ref}`)[0]).toMatchObject({ provider: "gtmapi", daily_invite_limit: 20 });
    });

    it("offers an account's own vendor in the form after a disconnect", async () => {
      const id = await org();
      await account(id);
      const { listLinkedInAccounts } = await import("../../application/linkedin-management");
      const state = await listLinkedInAccounts(composition.linkedinManagementDeps(), { organizationId: id, userId: "u", role: "admin" } as never);
      expect(state.connected).toBe(false);
      expect(state.vendor.key).toBe("unipile");
      expect(state.formVendor).toBe("gtmapi");
    });

    it("gives an account the gateway of its vendor, and refuses a connect link", async () => {
      const id = await org();
      const seller = await account(id);
      await accounts.saveCredentials(id, { apiKey: "gtm_live_k", notifySecret: "n" }, { key: "gtmapi", integrationName: "gtm-api (LinkedIn)" });
      const gateway = await composition.linkedinGateways().forAccount({ organizationId: id, accountId: seller.id });
      expect(gateway?.constructor.name).toBe("GtmGateway");
      const { createConnectLink } = await import("../../application/linkedin-connect");
      await expect(createConnectLink(composition.linkedinManagementDeps(), { organizationId: id, userId: "u", role: "admin" } as never)).rejects.toThrow("Connect the account in gtm-api, then choose Sync accounts.");
      expect((await sql`select count(*)::int as n from linkedin_connect_links where organization_id = ${id}`)[0].n).toBe(0);
    });
  });
});
