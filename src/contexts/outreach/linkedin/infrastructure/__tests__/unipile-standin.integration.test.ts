import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/shared/errors";
import { ValidationError } from "@/shared/errors";
import { NOT_FOUND_GRACE_MINUTES, UNCERTAIN_AFTER_MINUTES } from "../../../domain/send-policy";
import type { LinkedInEngineDeps, LinkedInGatewayProvider, LinkedInInboundDeps } from "../../application/linkedin-ports";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";
import { startUnipileStandin, type UnipileStandin } from "./unipile-standin";
import { UnipileGateway } from "../unipile-gateway";

/*
 * LOCAL STAND-IN TESTS. The real UnipileGateway, engine, stores and webhook route handler run against a local HTTP
 * server (`unipile-standin.ts` in this folder) that follows the Unipile reference. This is NOT a verification against
 * the real Unipile service: real rate limits, payload quirks, webhook timing and account connection are not covered.
 *
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [
  { stepNumber: 1, kind: "invitation", body: "Hi {{firstName}}, let us connect", waitDays: 0 },
  { stepNumber: 2, kind: "message", body: "Thanks {{firstName}} from {{company}}", waitDays: 1 },
  { stepNumber: 3, kind: "message", body: "Following up", waitDays: 3 },
];
const API_KEY = "standin-key-123";
const APP_URL = "https://app.example.com";

describeDb("unipile gateway against the local stand-in", () => {
  useTestEnv({ LINKEDIN_PROVIDER: undefined });
  const sql = testSql({ max: 6 });
  let engine: typeof import("../../application/send-next-linkedin");
  let inbound: typeof import("../../application/linkedin-inbound");
  let mgmt: typeof import("../../application/linkedin-management");
  let searchUc: typeof import("../../application/linkedin-search");
  let searchEngine: typeof import("../../application/run-linkedin-search");
  let store: typeof import("../drizzle-linkedin-store").drizzleLinkedInStore;
  let inboundStore: ReturnType<typeof import("../drizzle-linkedin-inbound-store").createDrizzleLinkedInInboundStore>;
  let accountStore: typeof import("../drizzle-linkedin-account-store").drizzleLinkedInAccountStore;
  let connectStore: typeof import("../drizzle-linkedin-connect-store").drizzleLinkedInConnectStore;
  let auditSink: typeof import("@/contexts/tenancy/infrastructure/audit").auditSink;
  let searchStore: typeof import("../drizzle-linkedin-search-store").drizzleLinkedInSearchStore;
  let searchEngineStore: typeof import("../drizzle-linkedin-search-store").drizzleLinkedInSearchEngineStore;
  let campaignStore: typeof import("../drizzle-linkedin-campaign-store").drizzleLinkedInCampaignStore;
  let sink: typeof import("../search-lead-sink").searchLeadSink;
  let parse: typeof import("../unipile-webhook").parseUnipilePayload;
  let composition: typeof import("../linkedin-composition");
  let route: typeof import("@/app/api/webhooks/unipile/route");
  const cleanup: Array<Pick<TestOrg, "organizationId"> & Partial<TestOrg>> = [];

  // Real time plus an offset: the stand-in stamps messages with the real clock, and the engine reads "after" from its own.
  let offsetMs = 0;
  const clock = { now: () => new Date(Date.now() + offsetMs) };
  const advance = (minutes: number) => {
    offsetMs += minutes * 60_000;
  };

  let standin: UnipileStandin;
  beforeEach(async () => {
    offsetMs = 0;
    standin = await startUnipileStandin({
      apiKey: API_KEY,
      now: () => clock.now(),
      // The webhook goes straight into the real route handler, with the headers the adapter registered.
      deliver: (target, init) => route.POST(new Request(target, init)),
    });
  });
  afterEach(async () => {
    await standin.close();
  });

  /** A provider with a short timeout so hang tests finish fast. */
  const shortProvider = (timeoutMs = 400): LinkedInGatewayProvider => ({
    forOrganization: async () => new UnipileGateway({ dsn: standin.dsn, apiKey: API_KEY, timeoutMs, scheme: "http" }),
  });
  const engineDeps = (gateways: LinkedInGatewayProvider = shortProvider()): LinkedInEngineDeps => ({ store, gateways, clock, random: () => 0 });
  const inboundDeps = (): LinkedInInboundDeps => ({ store: inboundStore, clock, parse });
  const mgmtDeps = () => ({ accounts: accountStore, gatewayFor: (c: { dsn: string; apiKey: string; scheme?: "http" | "https" }) => new UnipileGateway(c), dsnPolicy: { allowedHosts: [], allowLoopback: true }, appUrl: APP_URL, now: () => clock.now(), audit: auditSink, connectLinks: connectStore });

  async function fixture(options: { people?: number; steps?: unknown[]; distance?: "SECOND_DEGREE" | "FIRST_DEGREE" } = {}) {
    const tag = uniqueKey();
    // The reconcile job reads unknown sends of every organization, so leftovers of earlier tests must not count.
    await sql`update sends set status = 'failed' where status = 'unknown'`;
    const created = await createTestOrg(sql, "U");
    cleanup.push(created);
    const { organizationId: org, userId } = created;
    const owner = standin.addAccount({ id: "acct-" + tag, memberId: "ACoOwner" + tag, publicIdentifier: "owner-" + tag, name: "Owner Seller" });
    const actor: Actor = { userId, organizationId: org, role: "owner" };
    const connected = await mgmt.connectLinkedIn(mgmtDeps(), actor, { dsn: standin.dsn, apiKey: API_KEY });
    const [account] = await sql`select * from linkedin_accounts where organization_id = ${org}`;
    await sql`update linkedin_accounts set working_hours = ${sql.json({ timeZone: "UTC", days: ALL_DAY } as never)}, daily_invite_limit = 50 where id = ${account.id}`;
    const [{ id: campaign }] = await sql`
      insert into campaigns (organization_id, channel, name, status, steps)
      values (${org}, 'linkedin', 'c', 'active', ${sql.json((options.steps ?? STEPS) as never)}) returning id`;
    const [{ id: company }] = await sql`insert into companies (organization_id, domain, name) values (${org}, ${`acme-${tag}.com`}, 'Acme') returning id`;
    const enrollmentIds: string[] = [];
    const slugs: string[] = [];
    for (let i = 0; i < (options.people ?? 1); i++) {
      const slug = `lead${i}-${tag}`;
      slugs.push(slug);
      standin.addProfile({ publicIdentifier: slug, firstName: "Lead" + i, lastName: "Person", distance: options.distance ?? "SECOND_DEGREE" });
      const created = new Date(Date.now() + i * 1000);
      const [{ id: person }] = await sql`
        insert into people (organization_id, linkedin_slug, first_name, company_id, created_at)
        values (${org}, ${slug}, ${"Lead" + i}, ${company}, ${created}) returning id`;
      const [{ id: enrollment }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, created_at)
        values (${org}, ${campaign}, ${person}, 'linkedin', ${created}) returning id`;
      await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, profile_url) values (${enrollment}, ${org}, ${"https://www.linkedin.com/in/" + slug})`;
      enrollmentIds.push(enrollment);
    }
    return { org, tag, actor, owner, connected, accountId: account.id as string, campaign, enrollmentIds, slugs, providerOf: (i = 0) => standin.profiles.find((p) => p.publicIdentifier === slugs[i])!.providerId };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const enrollment = async (id: string) => (await sql`select * from campaign_enrollments where id = ${id}`)[0];
  const details = async (id: string) => (await sql`select * from linkedin_enrollment_details where enrollment_id = ${id}`)[0];
  const sendRows = async (id: string) => await sql`select * from sends where enrollment_id = ${id} order by step_number, claimed_at`;
  const accountRow = async (id: string) => (await sql`select * from linkedin_accounts where id = ${id}`)[0];
  const inboxRows = async (org: string) =>
    sql`select m.*, c.provider_thread_id, c.channel as conversation_channel from messages m join conversations c on c.id = m.conversation_id where m.organization_id = ${org} order by m.created_at`;

  /** One engine action. The pacing gap between actions of an account is 10 to 20 minutes, so the clock moves first. */
  const act = async (f: Fixture, deps = engineDeps()) => {
    advance(21);
    return engine.runNextLinkedInAction(deps, f.accountId);
  };
  /** Resolve the profile, then send the invitation. */
  async function invite(f: Fixture, deps = engineDeps()) {
    expect((await act(f, deps)).kind).toBe("resolved");
    return act(f, deps);
  }

  /** Delivers an event the way Unipile would, through the registered webhook and the real route. */
  async function deliver(payload: Record<string, unknown>) {
    const results = await standin.deliverWebhook(payload);
    expect(results.length).toBeGreaterThan(0);
    return results;
  }

  beforeAll(async () => {
    engine = await import("../../application/send-next-linkedin");
    inbound = await import("../../application/linkedin-inbound");
    mgmt = await import("../../application/linkedin-management");
    searchUc = await import("../../application/linkedin-search");
    searchEngine = await import("../../application/run-linkedin-search");
    ({ drizzleLinkedInStore: store } = await import("../drizzle-linkedin-store"));
    inboundStore = (await import("../drizzle-linkedin-inbound-store")).createDrizzleLinkedInInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
    ({ drizzleLinkedInAccountStore: accountStore } = await import("../drizzle-linkedin-account-store"));
    ({ drizzleLinkedInConnectStore: connectStore } = await import("../drizzle-linkedin-connect-store"));
    ({ auditSink } = await import("@/contexts/tenancy/infrastructure/audit"));
    ({ drizzleLinkedInSearchStore: searchStore, drizzleLinkedInSearchEngineStore: searchEngineStore } = await import("../drizzle-linkedin-search-store"));
    ({ drizzleLinkedInCampaignStore: campaignStore } = await import("../drizzle-linkedin-campaign-store"));
    ({ searchLeadSink: sink } = await import("../search-lead-sink"));
    ({ parseUnipilePayload: parse } = await import("../unipile-webhook"));
    composition = await import("../linkedin-composition");
    route = await import("@/app/api/webhooks/unipile/route");
  });

  afterAll(async () => {
    await dropOrgs(sql, cleanup);
    await sql.end();
  });

  describe("connection, sync and webhook registration", () => {
    it("verifies the key, syncs LinkedIn accounts only, and registers both webhooks with the secret header", async () => {
      standin.addAccount({ type: "GOOGLE_OAUTH", name: "Mail" });
      standin.addAccount({ status: "ERROR", name: "Broken", memberId: "ACoBroken", publicIdentifier: "broken" });
      const f = await fixture();

      // Every call carries the key, and verify is a one-item account list.
      expect(standin.requests.every((r) => r.headers["x-api-key"] === API_KEY)).toBe(true);
      expect(standin.calls("GET /api/v1/accounts")[0].query).toEqual({ limit: ["1"] });
      expect(f.connected.accounts).toBe(2);
      // users/me is only asked for the account that is connected.
      expect(standin.calls("GET /api/v1/users/me").map((r) => r.query.account_id[0])).toEqual([f.owner.id]);
      const rows = await sql`select provider_account_id, status from linkedin_accounts where organization_id = ${f.org} order by provider_account_id`;
      expect(rows.map((r) => [r.provider_account_id, r.status]).sort()).toEqual(
        [
          [f.owner.id, "connected"],
          [standin.accounts[1].id, "disconnected"],
        ].sort(),
      );

      expect(f.connected.webhooks.status).toBe("registered");
      expect(standin.webhooks.map((h) => [h.source, h.events])).toEqual([
        ["users", ["new_relation"]],
        ["messaging", ["message_received"]],
      ]);
      const hook = standin.webhooks[0];
      expect(hook.requestUrl).toBe(`${APP_URL}/api/webhooks/unipile?org=${f.org}`);
      expect(hook.headers.find((h) => h.key === "x-unipile-secret")?.value).toMatch(/^[\w-]{20,}$/);
      expect(hook.format).toBe("json");

      // Running the connection again replaces the registrations of the same URL.
      await mgmt.registerLinkedInWebhooks(mgmtDeps(), f.actor);
      expect(standin.webhooks).toHaveLength(2);
      expect(standin.calls("DELETE /api/v1/webhooks/:id")).toHaveLength(2);
    });

    it("rejects a wrong key with a message a person can act on and stores nothing", async () => {
      standin.addAccount();
      const [{ id: org }] = await sql`insert into organizations (name, slug) values ('U', ${"un-bad-" + uniqueKey()}) returning id`;
      cleanup.push({ organizationId: org });
      const actor: Actor = { userId: "00000000-0000-0000-0000-000000000000", organizationId: org, role: "owner" };
      await expect(mgmt.connectLinkedIn(mgmtDeps(), actor, { dsn: standin.dsn, apiKey: "wrong" })).rejects.toThrow(ValidationError);
      expect(await accountStore.getCredentials(org)).toBeNull();
      expect(standin.calls()[0]).toMatchObject({ status: 401 });
    });

    it("hands out a working gateway from the composition root for the stored credentials", async () => {
      const f = await fixture();
      const gateway = await composition.linkedinGateways({ allowLoopback: true }).forOrganization(f.org);
      expect(gateway).toBeInstanceOf(UnipileGateway);
      await gateway!.verify();
      expect((await gateway!.listAccounts()).map((a) => a.ref)).toEqual([f.owner.id]);
    });

    it("pages through accounts by cursor", async () => {
      standin.options.pageCap = 2;
      for (let i = 0; i < 5; i++) standin.addAccount({ memberId: `ACoMany${i}`, publicIdentifier: `many-${i}`, name: `Many ${i}` });
      const gateway = new UnipileGateway({ dsn: standin.dsn, apiKey: API_KEY, scheme: "http" });
      expect(await gateway.listAccounts()).toHaveLength(5);
      const pages = standin.calls("GET /api/v1/accounts");
      expect(pages).toHaveLength(3);
      expect(pages[0].query.cursor).toBeUndefined();
      expect(pages[1].query.cursor).toHaveLength(1);
    });
  });

  describe("invitation, acceptance, message and reply end to end", () => {
    it("runs the whole sequence, and a reply stops it and lands in the inbox", async () => {
      const f = await fixture();
      const member = f.providerOf();

      expect((await act(f)).kind).toBe("resolved");
      expect(standin.calls("GET /api/v1/users/:identifier")[0]).toMatchObject({ path: `/api/v1/users/${f.slugs[0]}`, query: { account_id: [f.owner.id] } });
      expect(await details(f.enrollmentIds[0])).toMatchObject({ provider_id: member });

      expect((await act(f)).kind).toBe("sent");
      const invite = standin.calls("POST /api/v1/users/invite");
      expect(invite).toHaveLength(1);
      expect(invite[0].contentType).toBe("application/json");
      expect(invite[0].json).toEqual({ provider_id: member, account_id: f.owner.id, message: "Hi Lead0, let us connect" });
      expect(standin.invitations).toHaveLength(1);
      expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "request_sent" });

      // Unipile reports the acceptance (up to 8 hours late in reality, immediate here).
      const [delivery] = await deliver(standin.accept(f.owner.id, member));
      expect(delivery.status).toBe(200);
      expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "connected" });
      const events = await sql`select event_type, status, provider_event_key as key from inbound_events where organization_id = ${f.org}`;
      expect(events).toEqual([{ event_type: "connection_accepted", status: "done", key: `unipile:new_relation:v2:${f.org}:${f.owner.id}:${member}` }]);

      // Step 2 is due one day after acceptance and starts a chat (multipart, first degree now).
      advance(25 * 60);
      expect((await act(f)).kind).toBe("sent");
      const started = standin.calls("POST /api/v1/chats");
      expect(started).toHaveLength(1);
      expect(started[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(started[0].form).toEqual({ account_id: [f.owner.id], attendees_ids: [member], text: ["Thanks Lead0 from Acme"] });
      expect(standin.chats).toHaveLength(1);

      // The lead answers in that chat.
      await deliver(standin.reply(f.owner.id, member, "Sounds good, call me"));
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "replied", next_send_at: null, stop_reason: "replied" });
      const inbox = await inboxRows(f.org);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ conversation_channel: "linkedin", provider_thread_id: standin.chats[0].id });
      expect(JSON.stringify(inbox[0])).toContain("Sounds good, call me");

      // Nothing more goes out.
      advance(24 * 60 * 5);
      expect((await act(f)).kind).toBe("idle");
      expect(standin.calls("POST /api/v1/chats")).toHaveLength(1);
      expect(standin.calls("POST /api/v1/chats/:chat_id/messages")).toHaveLength(0);
    });

    it("sends later messages into the existing chat with a multipart form", async () => {
      const f = await fixture();
      const member = f.providerOf();
      await invite(f);
      await deliver(standin.accept(f.owner.id, member));
      advance(25 * 60);
      expect((await act(f)).kind).toBe("sent");
      advance(4 * 24 * 60);
      expect((await act(f)).kind).toBe("sent");
      const sent = standin.calls("POST /api/v1/chats/:chat_id/messages");
      expect(sent).toHaveLength(1);
      expect(sent[0].form).toEqual({ text: ["Following up"], account_id: [f.owner.id] });
      expect(standin.calls("GET /api/v1/chat_attendees/:attendee_id/chats").length).toBeGreaterThan(0);
      expect(standin.messages.filter((m) => m.isSender).map((m) => m.text)).toEqual(["Thanks Lead0 from Acme", "Following up"]);
    });

    it("ignores the echo of our own messages and keeps the sequence running", async () => {
      standin.options.echoOwnMessages = true;
      const f = await fixture();
      const member = f.providerOf();
      await invite(f);
      await deliver(standin.accept(f.owner.id, member));
      advance(25 * 60);
      expect((await act(f)).kind).toBe("sent");
      // The stand-in posts the echo without waiting; it records the delivery once the route has answered.
      const echo = await vi.waitFor(() => {
        const found = standin.deliveries.find((d) => (d.event as { event: string }).event === "message_received");
        if (!found) throw new Error("no echo delivered yet");
        return found;
      });
      expect(echo.status).toBe(200);
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "active" });
      expect(await inboxRows(f.org)).toHaveLength(0);
    });

    it("answers a repeated delivery as a duplicate without a second inbox row", async () => {
      const f = await fixture();
      const member = f.providerOf();
      await invite(f);
      await deliver(standin.accept(f.owner.id, member));
      advance(25 * 60);
      await act(f);
      const reply = standin.reply(f.owner.id, member, "Yes");
      await deliver(reply);
      await deliver(reply);
      expect(await inboxRows(f.org)).toHaveLength(1);
      expect(standin.deliveries.at(-1)?.status).toBe(200);
    });

    it("fails a first message to someone who is not a connection (422, definite) and does not retry it as an outage", async () => {
      const f = await fixture();
      const member = f.providerOf();
      await invite(f);
      // A new_relation arrives although the stand-in still says second degree: startChat is refused by the documented rule.
      await deliver({ ...standin.accept(f.owner.id, member), user_provider_id: member });
      standin.profiles.find((p) => p.providerId === member)!.distance = "SECOND_DEGREE";
      advance(25 * 60);
      const outcome = await act(f);
      expect(outcome).toMatchObject({ kind: "failed", retry: false });
      expect(standin.calls("POST /api/v1/chats")[0].status).toBe(422);
    });
  });

  describe("definite refusals and unknown outcomes", () => {
    it("pauses the account for a rate limit (429) and gives the attempt back", async () => {
      const f = await fixture();
      standin.setFault("POST /api/v1/users/invite", { kind: "rate_limit", times: 1 });
      expect((await invite(f)).kind).toBe("paused");
      expect(standin.invitations).toHaveLength(0);
      expect((await accountRow(f.accountId)).limit_reached_until).not.toBeNull();
      expect((await details(f.enrollmentIds[0])).connection_state).toBe("none");
      // The pause is 24 hours, then the same lead is invited.
      advance(25 * 60);
      expect((await act(f)).kind).toBe("sent");
      expect(standin.invitations).toHaveLength(1);
    });

    it("treats the documented 422 cannot_resend_yet as a provider limit", async () => {
      const f = await fixture();
      standin.setFault("POST /api/v1/users/invite", { kind: "status", status: 422, body: { title: "Cannot resend yet", type: "errors/cannot_resend_yet", status: 422 }, times: 1 });
      expect((await invite(f)).kind).toBe("paused");
      expect((await accountRow(f.accountId)).limit_reached_until).not.toBeNull();
    });

    it("skips the invitation when the stand-in says already connected (422)", async () => {
      const f = await fixture({ distance: "FIRST_DEGREE" });
      expect((await invite(f)).kind).toBe("sent");
      expect(standin.calls("POST /api/v1/users/invite")[0].status).toBe(422);
      expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "connected" });
    });

    it("counts already_invited_recently (422) as sent", async () => {
      const f = await fixture();
      standin.invitations.push({ id: "old", account: f.owner.id, invitedUserId: f.providerOf(), publicId: f.slugs[0], text: null, at: clock.now() });
      expect((await invite(f)).kind).toBe("sent");
      expect(standin.calls("POST /api/v1/users/invite")[0].status).toBe(422);
      expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "request_sent" });
    });

    it("marks the account disconnected on 401 and releases the send", async () => {
      const f = await fixture();
      standin.setFault("POST /api/v1/users/invite", { kind: "status", status: 401, body: { title: "Disconnected", type: "errors/disconnected_account", status: 401 }, times: 1 });
      expect((await invite(f)).kind).toBe("paused");
      expect((await accountRow(f.accountId)).status).not.toBe("connected");
    });

    it("fails a lead whose profile the provider does not know (404 on lookup)", async () => {
      const f = await fixture();
      standin.profiles.length = 0;
      expect((await act(f)).kind).toBe("resolve_failed");
    });

    it("keeps the unknown outcome of a 500, never retries it blindly, and re-sends only after reconcile finds nothing", async () => {
      const f = await fixture();
      standin.setFault("POST /api/v1/users/invite", { kind: "server_error", times: 1 });
      expect((await invite(f)).kind).toBe("unknown");
      expect((await sendRows(f.enrollmentIds[0]))[0].status).toBe("unknown");
      expect(standin.invitations).toHaveLength(0);
      // Not due for reconciliation yet.
      expect(await engine.reconcileLinkedInSends(engineDeps())).toMatchObject({ checked: 0 });
      advance(UNCERTAIN_AFTER_MINUTES + 1);
      // Looked up (sent list, then profile) and not found, but not long enough to be sure.
      expect(await engine.reconcileLinkedInSends(engineDeps())).toMatchObject({ checked: 1, stillWaiting: 1 });
      expect(standin.calls("GET /api/v1/users/invite/sent")).toHaveLength(1);
      advance(NOT_FOUND_GRACE_MINUTES);
      expect(await engine.reconcileLinkedInSends(engineDeps())).toMatchObject({ checked: 1, retryable: 1 });
      expect((await act(f)).kind).toBe("sent");
      expect(standin.invitations).toHaveLength(1);
    });

    it("finds an invitation that was created before the answer timed out, and does not send it twice", async () => {
      const f = await fixture();
      standin.setFault("POST /api/v1/users/invite", { kind: "hang", applyEffect: true, times: 1 });
      expect((await invite(f)).kind).toBe("unknown");
      expect(standin.invitations).toHaveLength(1);
      advance(UNCERTAIN_AFTER_MINUTES + 1);
      expect(await engine.reconcileLinkedInSends(engineDeps())).toMatchObject({ checked: 1, foundSent: 1 });
      expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "request_sent" });
      expect(standin.calls("POST /api/v1/users/invite")).toHaveLength(1);
    });

    it("reads an accepted invitation (gone from the sent list, first degree) as accepted during reconcile", async () => {
      const f = await fixture();
      standin.setFault("POST /api/v1/users/invite", { kind: "hang", applyEffect: true, times: 1 });
      expect((await invite(f)).kind).toBe("unknown");
      standin.accept(f.owner.id, f.providerOf());
      advance(UNCERTAIN_AFTER_MINUTES + 1);
      expect(await engine.reconcileLinkedInSends(engineDeps())).toMatchObject({ foundSent: 1 });
      expect(await details(f.enrollmentIds[0])).toMatchObject({ connection_state: "connected" });
    });

    it("treats a 200 with a body that is not JSON as unknown, then finds the invitation", async () => {
      const f = await fixture();
      standin.setFault("POST /api/v1/users/invite", { kind: "malformed", applyEffect: true, times: 1 });
      expect((await invite(f)).kind).toBe("unknown");
      advance(UNCERTAIN_AFTER_MINUTES + 1);
      expect(await engine.reconcileLinkedInSends(engineDeps())).toMatchObject({ foundSent: 1 });
      expect(standin.invitations).toHaveLength(1);
    });

    it("reconciles an unknown first message by finding it in the chat the timeout hid", async () => {
      const f = await fixture();
      const member = f.providerOf();
      await invite(f);
      await deliver(standin.accept(f.owner.id, member));
      standin.setFault("POST /api/v1/chats", { kind: "hang", applyEffect: true, times: 1 });
      advance(25 * 60);
      expect((await act(f)).kind).toBe("unknown");
      expect(standin.messages).toHaveLength(1);
      advance(UNCERTAIN_AFTER_MINUTES + 1);
      expect(await engine.reconcileLinkedInSends(engineDeps())).toMatchObject({ checked: 1, foundSent: 1 });
      const listed = standin.calls("GET /api/v1/chats/:chat_id/messages")[0];
      expect(listed.query.after[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(standin.calls("POST /api/v1/chats")).toHaveLength(1);
    });

    it("treats a 503 on a message as unknown and a 429 as a provider limit", async () => {
      const f = await fixture();
      const member = f.providerOf();
      await invite(f);
      await deliver(standin.accept(f.owner.id, member));
      standin.setFault("POST /api/v1/chats", { kind: "unavailable", times: 1 });
      advance(25 * 60);
      expect((await act(f)).kind).toBe("unknown");
      standin.setFault("POST /api/v1/chats", { kind: "rate_limit", times: 1 });
      advance(UNCERTAIN_AFTER_MINUTES + NOT_FOUND_GRACE_MINUTES + 5);
      await engine.reconcileLinkedInSends(engineDeps());
      expect((await act(f)).kind).toBe("paused");
    });
  });

  describe("webhook route", () => {
    const post = (org: string, secret: string | null, body: unknown, rawBody?: string) =>
      route.POST(
        new Request(`${APP_URL}/api/webhooks/unipile?org=${org}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-unipile-secret": secret }) },
          body: rawBody ?? JSON.stringify(body),
        }),
      );

    it("answers 401 for a wrong secret, a missing secret and a bad organization, and stores nothing", async () => {
      const f = await fixture();
      const payload = standin.accept(f.owner.id, "ACoSomeone");
      expect((await post(f.org, "wrong-secret-value", payload)).status).toBe(401);
      expect((await post(f.org, null, payload)).status).toBe(401);
      expect((await post("not-a-uuid", "x", payload)).status).toBe(401);
      expect((await post("00000000-0000-4000-8000-000000000000", "x", payload)).status).toBe(401);
      expect(await sql`select 1 from inbound_events where organization_id = ${f.org}`).toHaveLength(0);
    });

    it("accepts the secret the adapter registered, rejects invalid JSON with 400 and ignores other accounts", async () => {
      const f = await fixture();
      const secret = standin.webhooks[0].headers.find((h) => h.key === "x-unipile-secret")!.value;
      expect((await post(f.org, secret, null, "{nope")).status).toBe(400);
      const ignored = await post(f.org, secret, { event: "new_relation", account_id: f.owner.id, account_type: "INSTAGRAM", user_provider_id: "x" });
      expect(await ignored.json()).toEqual({ ok: true, status: "ignored" });
      const ok = await post(f.org, secret, standin.accept(f.owner.id, "ACoSomeone"));
      expect(ok.status).toBe(200);
    });

    it("lets the replay job finish a delivery whose processing failed", async () => {
      const f = await fixture();
      const member = f.providerOf();
      await invite(f);
      const before = await enrollment(f.enrollmentIds[0]);
      expect(before.status).toBe("active");
      await deliver(standin.reply(f.owner.id, member, "hello"));
      expect(await enrollment(f.enrollmentIds[0])).toMatchObject({ status: "replied" });
      expect((await inbound.replayLinkedInEvents(inboundDeps())).failed).toBe(0);
    });
  });

  describe("search", () => {
    const SEARCH_URL = "https://www.linkedin.com/search/results/people/?keywords=cto";
    const people = (n: number) => Array.from({ length: n }, (_v, i) => ({ providerId: `ACoAAAsearch${i}`.padEnd(39, "x"), name: `Found${i} Person`, headline: `Role ${i}` }));
    const deps = (gateways: LinkedInGatewayProvider = shortProvider()) => ({ store: searchEngineStore, gateways, sink, clock, random: () => 0 });
    const page = async (d = deps()) => {
      const outcome = await searchEngine.runNextSearchPage(d);
      advance(1);
      return outcome;
    };

    it("pages through a classic people search by cursor and stores the results", async () => {
      const f = await fixture();
      standin.searchResults = people(25);
      const { id } = await searchUc.createLinkedInSearch({ searches: searchStore, campaigns: campaignStore }, f.actor, { name: "CTOs", url: SEARCH_URL });
      expect(await page()).toMatchObject({ kind: "page" });
      expect(await page()).toMatchObject({ kind: "page" });
      expect(await page()).toMatchObject({ kind: "page", done: true });
      const calls = standin.calls("POST /api/v1/linkedin/search");
      expect(calls).toHaveLength(3);
      expect(calls.map((c) => c.query.cursor?.[0] ?? null)).toEqual([null, expect.any(String), expect.any(String)]);
      expect(calls[0].query.account_id).toEqual([f.owner.id]);
      expect(calls[0].json).toEqual({ url: SEARCH_URL });
      const [query] = await sql`select * from linkedin_search_queries where id = ${id}`;
      expect(query).toMatchObject({ status: "completed", leads_fetched: 25, pages_fetched: 3 });
      const results = await sql`
        select r.profile_url, r.person_id, p.id as found_id, p.organization_id as person_org, r.organization_id as result_org, p.linkedin_url
        from linkedin_search_results r left join people p on p.id = r.person_id where r.query_id = ${id}`;
      expect(results).toHaveLength(25);
      for (const r of results) {
        expect(r.person_id).not.toBeNull();
        expect(r.found_id).toBe(r.person_id);
        expect(r.person_org).toBe(r.result_org);
        expect([null, r.profile_url, r.profile_url.replace(/\/?$/, "/")]).toContain(r.linkedin_url);
      }
      expect(new Set(results.map((r) => r.person_id)).size).toBe(25);
      // The classic result of the docs carries only a member id in profile_url, so each one becomes a lead known by that id.
      expect(await sql`select 1 from people where organization_id = ${f.org} and source like 'linkedin_search:%' and linkedin_slug is null and raw ? 'linkedin_member_id'`).toHaveLength(25);
    });

    it("pauses the account on 429 and retries the same cursor after a 5xx", async () => {
      const f = await fixture();
      standin.searchResults = people(15);
      const { id } = await searchUc.createLinkedInSearch({ searches: searchStore, campaigns: campaignStore }, f.actor, { name: "CTOs", url: SEARCH_URL });
      expect(await page()).toMatchObject({ kind: "page" });
      standin.setFault("POST /api/v1/linkedin/search", { kind: "server_error", times: 1 });
      const failed = await page();
      expect(failed.kind).not.toBe("page");
      const [query] = await sql`select * from linkedin_search_queries where id = ${id}`;
      expect(query.status).not.toBe("failed");
      expect(query.cursor).not.toBeNull();
      standin.setFault("POST /api/v1/linkedin/search", { kind: "rate_limit", times: 1 });
      advance(10);
      await page();
      expect((await accountRow(f.accountId)).limit_reached_until).not.toBeNull();
    });

    it("refuses a malformed search URL in the stand-in the same way the docs describe", async () => {
      const f = await fixture();
      const gateway = new UnipileGateway({ dsn: standin.dsn, apiKey: API_KEY, scheme: "http" });
      await expect(gateway.searchPeople({ account: f.owner.id, searchUrl: "https://example.com/x", cursor: null })).rejects.toMatchObject({ kind: "definite" });
    });
  });
});
