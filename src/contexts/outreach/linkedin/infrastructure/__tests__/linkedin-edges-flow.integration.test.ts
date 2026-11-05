import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { Actor } from "@/shared/errors";
import type { LinkedInInboundDeps, LinkedInInboundRead } from "../../application/linkedin-ports";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const NEVER = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), []]));
const STEPS = [
  { stepNumber: 1, kind: "invitation", body: "", waitDays: 0 },
  { stepNumber: 2, kind: "message", body: "Thanks", waitDays: 1 },
];
const EDGES = { key: "edges", integrationName: "Edges (LinkedIn)" };
const UNIPILE = { key: "unipile", integrationName: "Unipile (LinkedIn)" };

describeDb("LinkedIn accounts on a second vendor", () => {
  useTestEnv({ LINKEDIN_PROVIDER: undefined });
  const sql = testSql({ max: 6 });
  let accounts: typeof import("../drizzle-linkedin-account-store").drizzleLinkedInAccountStore;
  let pollStore: typeof import("../drizzle-linkedin-inbound-read-store").drizzleLinkedInInboundPollStore;
  let store: typeof import("../drizzle-linkedin-store").drizzleLinkedInStore;
  let inbound: LinkedInInboundDeps;
  let composition: typeof import("../linkedin-composition");
  let poll: typeof import("../../application/poll-linkedin-inbound");
  let connect: typeof import("../../application/linkedin-connect");
  let mgmt: typeof import("../../application/linkedin-management");
  let edgesVendor: typeof import("../vendors/edges/edges-vendor");
  let unipileVendor: typeof import("../vendors/unipile/unipile-vendor");
  const orgs: string[] = [];

  async function org() {
    const tag = uniqueKey();
    const [{ id }] = await sql`insert into organizations (name, slug) values ('E', ${"edges-" + tag}) returning id`;
    orgs.push(id);
    return { id: id as string, tag };
  }

  async function account(f: { id: string; tag: string }, provider: string, options: { readAt?: Date | null; hours?: unknown } = {}) {
    const ref = `${provider}-${f.tag}-${uniqueKey()}`;
    const [{ id }] = await sql`
      insert into linkedin_accounts (organization_id, provider, provider_account_id, linkedin_id, username, status, daily_invite_limit, working_hours, inbound_read_at)
      values (${f.id}, ${provider}, ${ref}, ${"ACoAAowner" + ref}, ${"owner-" + ref}, 'connected', 20, ${sql.json((options.hours ?? { timeZone: "UTC", days: ALL_DAY }) as never)}, ${options.readAt ?? null})
      returning id`;
    return { id: id as string, ref };
  }

  async function lead(f: { id: string; tag: string }, member?: string) {
    const slug = `lead-${uniqueKey()}`;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.id}, 'linkedin', 'c', 'active', ${sql.json(STEPS as never)}) returning id`;
    const [{ id: person }] = await sql`insert into people (organization_id, linkedin_slug, first_name) values (${f.id}, ${slug}, 'Ada') returning id`;
    const [{ id: enrollment }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${f.id}, ${campaign}, ${person}, 'linkedin') returning id`;
    await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, profile_url, provider_id) values (${enrollment}, ${f.id}, ${"https://www.linkedin.com/in/" + slug}, ${member ?? null})`;
    return { enrollment: enrollment as string, slug };
  }

  beforeAll(async () => {
    ({ drizzleLinkedInAccountStore: accounts } = await import("../drizzle-linkedin-account-store"));
    ({ drizzleLinkedInInboundPollStore: pollStore } = await import("../drizzle-linkedin-inbound-read-store"));
    ({ drizzleLinkedInStore: store } = await import("../drizzle-linkedin-store"));
    composition = await import("../linkedin-composition");
    poll = await import("../../application/poll-linkedin-inbound");
    connect = await import("../../application/linkedin-connect");
    mgmt = await import("../../application/linkedin-management");
    edgesVendor = await import("../vendors/edges/edges-vendor");
    unipileVendor = await import("../vendors/unipile/unipile-vendor");
    const { createDrizzleLinkedInInboundStore } = await import("../drizzle-linkedin-inbound-store");
    const { inboxFiling } = await import("@/composition/inbox-filing");
    const edges = await import("../vendors/edges/edges-inbound");
    inbound = {
      store: createDrizzleLinkedInInboundStore(inboxFiling),
      clock: { now: () => new Date() },
      parse: (payload) => (edges.isEdgesDelivery(payload) ? edges.parseEdgesDelivery(payload) : null),
      unreadable: (payload) => (edges.isEdgesDelivery(payload) ? edges.unreadableEdgesDelivery(payload) : null),
      eventKey: (event, organizationId) => edges.edgesEventKey(event, organizationId),
    };
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    await sql.end();
  });

  describe("the claim", () => {
    const claim = (id: string, now: Date) => store.claimNext({ accountId: id, now, random: () => 0, defaultWorkingHours: () => ({ timeZone: "UTC", days: ALL_DAY }) as never });

    it("refuses a polled account until a read finished lately, so nothing goes out on old news", async () => {
      const f = await org();
      await lead(f);
      const now = new Date();
      const never = await account(f, "edges");
      expect(await claim(never.id, now)).toBeNull();
      const stale = await account(f, "edges", { readAt: new Date(now.getTime() - 16 * 60_000) });
      expect(await claim(stale.id, now)).toBeNull();
      const fresh = await account(f, "edges", { readAt: new Date(now.getTime() - 14 * 60_000) });
      expect(await claim(fresh.id, now)).toMatchObject({ kind: "resolve" });
    });

    it("does not ask this of a vendor that sends webhooks", async () => {
      const f = await org();
      await lead(f);
      const unipile = await account(f, "unipile");
      expect(await claim(unipile.id, new Date())).toMatchObject({ kind: "resolve" });
    });
  });

  describe("gateways", () => {
    it("hand an account only the vendor that holds it, so an in-flight send is not looked for in the wrong place", async () => {
      const f = await org();
      const onUnipile = await account(f, "unipile");
      const onEdges = await account(f, "edges");
      await accounts.saveCredentials(f.id, { apiKey: "k", notifySecret: "s" }, EDGES);
      const gateways = composition.linkedinGateways();
      const { EdgesGateway } = await import("../vendors/edges/edges-gateway");
      expect(await gateways.forAccount({ organizationId: f.id, accountId: onEdges.id })).toBeInstanceOf(EdgesGateway);
      expect(await gateways.forAccount({ organizationId: f.id, accountId: onUnipile.id })).toBeNull();
      expect(await gateways.forAccount({ organizationId: f.id, accountId: "00000000-0000-4000-8000-000000000000" })).toBeNull();
    });

    it("leave a send to a vendor no longer connected unsettled, and do not disconnect the rest", async () => {
      const f = await org();
      const onEdges = await account(f, "edges", { readAt: new Date() });
      const onUnipile = await account(f, "unipile");
      await accounts.saveCredentials(f.id, { dsn: "api1.unipile.com:13111", apiKey: "k", notifySecret: "s" }, UNIPILE);
      await accounts.clearCredentials(f.id);
      const statuses = await sql`select id, status from linkedin_accounts where organization_id = ${f.id}`;
      expect(statuses.find((r) => r.id === onUnipile.id)?.status).toBe("disconnected");
      expect(statuses.find((r) => r.id === onEdges.id)?.status).toBe("connected");
    });
  });

  describe("credentials", () => {
    it("read as connected with the fields each vendor needs, and not without them", async () => {
      const f = await org();
      await accounts.saveCredentials(f.id, { apiKey: "k", notifySecret: "s" }, EDGES);
      expect(await accounts.connectedVendor(f.id)).toBe("edges");
      expect(await accounts.getCredentials(f.id)).toEqual({ apiKey: "k", notifySecret: "s" });
      const g = await org();
      await accounts.saveCredentials(g.id, { apiKey: "k", notifySecret: "s" }, UNIPILE);
      expect(await accounts.getCredentials(g.id)).toBeNull();
    });

    it("stay with one vendor per organization", async () => {
      const f = await org();
      const actor: Actor = { userId: "00000000-0000-4000-8000-000000000001", organizationId: f.id, role: "owner" };
      await accounts.saveCredentials(f.id, { dsn: "api1.unipile.com:13111", apiKey: "k", notifySecret: "s" }, UNIPILE);
      const deps = { accounts, vendors: [unipileVendor.createUnipileVendor(), edgesVendor.createEdgesVendor()], appUrl: "https://app.test", now: () => new Date() } as never;
      await expect(mgmt.connectLinkedIn(deps, actor, { vendor: "edges", apiKey: "new" })).rejects.toThrow(/Disconnect Unipile first/);
    });
  });

  describe("sync", () => {
    const listed = (ref: string, linkedinId: string, username: string) => ({ ref, linkedinId, name: "N", username, status: "connected" as const, isPremium: false, headline: null });

    it("refuses a profile another vendor holds, and leaves that row alone", async () => {
      const f = await org();
      const held = await account(f, "unipile");
      const [row] = await sql`select linkedin_id, username from linkedin_accounts where id = ${held.id}`;
      const result = await accounts.upsertAccounts(f.id, [listed("edges-uid", row.linkedin_id, row.username)], "edges");
      expect(result).toMatchObject({ added: 0, updated: 0, skipped: 1 });
      expect(result.skippedReasons[0]).toMatch(/another LinkedIn provider/);
      const [after] = await sql`select provider, provider_account_id from linkedin_accounts where id = ${held.id}`;
      expect(after).toEqual({ provider: "unipile", provider_account_id: held.ref });
    });

    it("never writes the vendor of an existing row", async () => {
      const f = await org();
      const held = await account(f, "edges");
      const [row] = await sql`select linkedin_id, username from linkedin_accounts where id = ${held.id}`;
      await accounts.upsertAccounts(f.id, [listed(held.ref, row.linkedin_id, row.username)], "edges");
      expect((await sql`select provider from linkedin_accounts where id = ${held.id}`)[0].provider).toBe("edges");
    });

    it("does not add identities a vendor's workspace lists: it asks only about the accounts connected here", async () => {
      const f = await org();
      const known = await account(f, "edges");
      await account(f, "unipile");
      await accounts.saveCredentials(f.id, { apiKey: "k", notifySecret: "s" }, EDGES);
      const asked: string[][] = [];
      const gateway = { listAccounts: async (only?: string[]) => (asked.push(only ?? []), [{ ref: known.ref, linkedinId: null, name: null, username: null, status: "disconnected" as const }]) };
      const deps = { accounts, vendors: [unipileVendor.createUnipileVendor(), edgesVendor.createEdgesVendor()], appUrl: "https://app.test", now: () => new Date() } as never;
      expect(await mgmt.syncWith(deps, f.id, edgesVendor.createEdgesVendor(), gateway as never)).toMatchObject({ added: 0, updated: 1, changes: [{ ref: known.ref, to: "disconnected" }] });
      expect(asked).toEqual([[known.ref]]);
      const rows = await sql`select provider, status from linkedin_accounts where organization_id = ${f.id} order by provider`;
      expect(rows).toEqual([{ provider: "edges", status: "disconnected" }, { provider: "unipile", status: "connected" }]);
    });

    it("keeps an account disconnected when someone else is signed in to its identity, and brings its own sign-in back", async () => {
      const f = await org();
      const known = await account(f, "edges");
      await sql`update linkedin_accounts set status = 'disconnected' where id = ${known.id}`;
      const [{ username }] = await sql`select username from linkedin_accounts where id = ${known.id}`;
      await accounts.saveCredentials(f.id, { apiKey: "k", notifySecret: "s" }, EDGES);
      const deps = { accounts, vendors: [edgesVendor.createEdgesVendor()], appUrl: "https://app.test", now: () => new Date() } as never;
      const signedInAs = (who: string | null) => ({ listAccounts: async () => [{ ref: known.ref, linkedinId: null, name: null, username: who, status: "connected" as const }] }) as never;
      const statusNow = async () => (await sql`select status from linkedin_accounts where id = ${known.id}`)[0].status;

      await mgmt.syncWith(deps, f.id, edgesVendor.createEdgesVendor(), signedInAs("someone-else"));
      expect(await statusNow()).toBe("disconnected");
      await mgmt.syncWith(deps, f.id, edgesVendor.createEdgesVendor(), signedInAs(null));
      expect(await statusNow()).toBe("disconnected");
      await mgmt.syncWith(deps, f.id, edgesVendor.createEdgesVendor(), signedInAs(username));
      expect(await statusNow()).toBe("connected");
      await mgmt.syncWith(deps, f.id, edgesVendor.createEdgesVendor(), signedInAs("someone-else"));
      expect(await statusNow()).toBe("disconnected");
    });
  });

  describe("reading the inbox", () => {
    const pollDeps = (reads: LinkedInInboundRead[]) => ({
      store: pollStore,
      inbound,
      clock: { now: () => new Date() },
      source: { read: async () => reads.shift() ?? { deliveries: [], cursor: { done: true }, finishedRunStartedAt: new Date() } },
    });
    const far = () => Date.now() + 10_000;

    it("marks the account read when a read finishes, and keeps the cursor between steps", async () => {
      const f = await org();
      const a = await account(f, "edges");
      const started = new Date();
      const report = await poll.pollLinkedInInbound(pollDeps([{ deliveries: [], cursor: { step: 1 }, finishedRunStartedAt: null }, { deliveries: [], cursor: { step: 2 }, finishedRunStartedAt: started }]), far());
      expect(report.finished).toBeGreaterThanOrEqual(1);
      const [row] = await sql`select inbound_cursor, inbound_read_at from linkedin_accounts where id = ${a.id}`;
      expect(row.inbound_read_at).not.toBeNull();
    });

    it("skips an account outside its hours, and one read lately", async () => {
      const f = await org();
      const closed = await account(f, "edges", { hours: { timeZone: "UTC", days: NEVER } });
      const recent = await account(f, "edges", { readAt: new Date() });
      await poll.pollLinkedInInbound(pollDeps([]), far());
      const rows = await sql`select id, inbound_cursor from linkedin_accounts where id in (${closed.id}, ${recent.id})`;
      expect(rows.every((r) => r.inbound_cursor === null)).toBe(true);
    });

    it("keeps the account unread when a read fails, so the claim keeps refusing it, and disconnects it on a lost sign-in", async () => {
      const f = await org();
      const a = await account(f, "edges");
      const { LinkedInGatewayError } = await import("../../application/linkedin-ports");
      const failing = (error: Error) => ({ ...pollDeps([]), source: { read: async ({ account: ref }: { account: string }) => { if (ref === a.ref) throw error; return { deliveries: [], cursor: {}, finishedRunStartedAt: new Date() }; } } });
      await poll.pollLinkedInInbound(failing(new LinkedInGatewayError("down", "unknown", "unavailable")), far());
      expect((await sql`select status, inbound_read_at from linkedin_accounts where id = ${a.id}`)[0]).toEqual({ status: "connected", inbound_read_at: null });
      await sql`update linkedin_accounts set inbound_lease_until = null where id = ${a.id}`;
      await poll.pollLinkedInInbound(failing(new LinkedInGatewayError("signed out", "definite", "auth")), far());
      expect((await sql`select status from linkedin_accounts where id = ${a.id}`)[0].status).toBe("disconnected");
    });

    it("lets a failed read wait, so one account that hangs does not hold the queue, for as long as the vendor says", async () => {
      const f = await org();
      const bad = await account(f, "edges");
      const limited = await account(f, "edges");
      const { LinkedInGatewayError } = await import("../../application/linkedin-ports");
      const asked: string[] = [];
      const deps = {
        ...pollDeps([]),
        source: {
          read: async ({ account: ref }: { account: string }) => {
            asked.push(ref);
            if (ref === bad.ref) throw new LinkedInGatewayError("timed out", "unknown", "unavailable");
            if (ref === limited.ref) throw new LinkedInGatewayError("out of credits", "definite", "rate_limited", 3_600_000);
            return { deliveries: [], cursor: {}, finishedRunStartedAt: new Date() };
          },
        },
      };
      await poll.pollLinkedInInbound(deps, far());
      expect(asked).toEqual(expect.arrayContaining([bad.ref, limited.ref]));
      const until = async (id: string) => (await sql`select inbound_lease_until from linkedin_accounts where id = ${id}`)[0].inbound_lease_until.getTime() - Date.now();
      expect(await until(bad.id)).toBeGreaterThan(2 * 60_000);
      expect(await until(bad.id)).toBeLessThanOrEqual(3 * 60_000);
      expect(await until(limited.id)).toBeGreaterThan(50 * 60_000);
      asked.length = 0;
      await poll.pollLinkedInInbound(deps, far());
      expect(asked).not.toContain(bad.ref);
      expect(asked).not.toContain(limited.ref);
    });

    it("lets one worker at a time read an account, and frees it when the read ends", async () => {
      const f = await org();
      const a = await account(f, "edges");
      const now = new Date();
      const input = { readBefore: now, now, until: new Date(now.getTime() + 60_000) };
      expect(await pollStore.claim(a.id, input)).toEqual({ cursor: null });
      expect(await pollStore.claim(a.id, input)).toBeNull();
      expect((await pollStore.listDue(now, now)).map((row) => row.id)).not.toContain(a.id);
      expect(await pollStore.claim(a.id, { ...input, now: new Date(now.getTime() + 61_000), until: new Date(now.getTime() + 120_000) })).toEqual({ cursor: null });
      await pollStore.release(a.id, null);
      expect((await pollStore.listDue(now, now)).map((row) => row.id)).toContain(a.id);
      await sql`update linkedin_accounts set inbound_read_at = ${now} where id = ${a.id}`;
      expect(await pollStore.claim(a.id, input)).toBeNull();
    });

    it("takes a lead's polled reply through the ledger, which stops the sequence, once", async () => {
      const f = await org();
      const a = await account(f, "edges");
      const member = `ACoAAlead${uniqueKey()}`;
      const { enrollment } = await lead(f, member);
      await sql`update campaign_enrollments set status = 'active', current_step = 1, linkedin_account_id = ${a.id} where id = ${enrollment}`;
      const delivery = { source: "edges-poll", kind: "message", account: a.ref, thread: "2-t", participants: [{ linkedin_profile_id: 222, sales_navigator_profile_id: member }], message: { message_id: "m1", linkedin_profile_id: 222, content: "Interested", delivered_at: new Date().toISOString() } };
      await poll.pollLinkedInInbound(pollDeps([{ deliveries: [delivery, delivery], cursor: {}, finishedRunStartedAt: new Date() }]), far());
      expect((await sql`select status from campaign_enrollments where id = ${enrollment}`)[0].status).toBe("replied");
      expect((await sql`select provider, status from inbound_events where organization_id = ${f.id}`)).toEqual([{ provider: "edges", status: "done" }]);
    });

    it("accepts a waiting lead from a polled connection", async () => {
      const f = await org();
      const a = await account(f, "edges");
      const member = `ACoAAlead${uniqueKey()}`;
      const { enrollment } = await lead(f, member);
      await sql`update campaign_enrollments set status = 'active', current_step = 1, linkedin_account_id = ${a.id} where id = ${enrollment}`;
      await sql`update linkedin_enrollment_details set connection_state = 'request_sent' where enrollment_id = ${enrollment}`;
      const delivery = { source: "edges-poll", kind: "connection", account: a.ref, connection: { linkedin_profile_id: 222, sales_navigator_profile_id: member, connected_at: new Date().toISOString() } };
      await poll.pollLinkedInInbound(pollDeps([{ deliveries: [delivery], cursor: {}, finishedRunStartedAt: new Date() }]), far());
      expect((await sql`select connection_state from linkedin_enrollment_details where enrollment_id = ${enrollment}`)[0].connection_state).toBe("connected");
    });

    it("leaves a message it cannot read where a person sees it", async () => {
      const f = await org();
      const a = await account(f, "edges");
      const delivery = { source: "edges-poll", kind: "message", account: a.ref, thread: "2-t", participants: [], message: { message_id: "m1", content: "stop" } };
      await poll.pollLinkedInInbound(pollDeps([{ deliveries: [delivery], cursor: {}, finishedRunStartedAt: new Date() }]), far());
      expect(await sql`select provider, status, event_type from inbound_events where organization_id = ${f.id}`).toEqual([{ provider: "edges", status: "failed", event_type: "message_received" }]);
    });
  });

  describe("connecting through a link that does not report back", () => {
    const setup = async (session: "pending" | "connected" | "failed", own: { member: string; slug: string }) => {
      const f = await org();
      const [{ id: user }] = await sql`insert into users (email, name) values (${`u-${f.tag}@example.com`}, 'U') returning id`;
      const actor: Actor = { userId: user, organizationId: f.id, role: "owner" };
      await accounts.saveCredentials(f.id, { apiKey: "k", notifySecret: "s" }, EDGES);
      const gateway = new FakeLinkedInGateway();
      const created = { url: "https://login", account: `uid-${f.tag}` };
      gateway.createConnectLink = async () => created;
      gateway.getOwnProfile = async () => ({ member: own.member, publicSlug: own.slug, firstName: "Ada", lastName: "L", headline: null, location: null, pictureUrl: null, networkDistance: "unknown", isPremium: true });
      const vendor = { ...edgesVendor.createEdgesVendor(), gatewayFor: () => gateway, connectSession: { status: async () => ({ state: session }), cancel: async () => { cancelled.push(created.account); } } };
      const cancelled: string[] = [];
      const { drizzleLinkedInConnectStore } = await import("../drizzle-linkedin-connect-store");
      const { auditSink } = await import("@/contexts/tenancy/infrastructure/audit");
      const deps = { accounts, vendors: [vendor], appUrl: "https://app.test", now: () => new Date(), audit: auditSink, connectLinks: drizzleLinkedInConnectStore };
      const link = await connect.createConnectLink(deps as never, actor);
      return { f, actor, deps: deps as never, link, ref: created.account, cancelled };
    };

    describe("when the link is a session that names the account", () => {
      const named = async (own: { member: string; slug: string }, reconnect = false) => {
        const t = await setup("connected", own);
        const account = `new-${uniqueKey()}`;
        const [vendor] = (t.deps as unknown as { vendors: Array<{ connectSession: { status: unknown } }> }).vendors;
        vendor.connectSession.status = async () => ({ state: "connected", account });
        if (reconnect) {
          const [{ id }] = await sql`insert into linkedin_accounts (organization_id, provider, provider_account_id, linkedin_id, username, status) values (${t.f.id}, 'edges', ${"old-" + account}, ${`ACoAAowner${account}`}, ${`owner-${account}`}, 'disconnected') returning id`;
          await sql`update linkedin_connect_links set reconnect_account_id = ${id} where id = ${t.link.linkId}`;
        }
        return { ...t, account };
      };

      it("connects the account it names, not the session", async () => {
        const key = uniqueKey();
        const t = await named({ member: `ACoAAada${key}`, slug: `ada-${key}` });
        expect(await connect.checkConnectLink(t.deps, t.actor, t.link.linkId)).toEqual({ status: "completed", error: null });
        expect((await sql`select provider_account_id from linkedin_accounts where organization_id = ${t.f.id}`)[0].provider_account_id).toBe(t.account);
        expect((await sql`select provider_account_id from linkedin_connect_links where id = ${t.link.linkId}`)[0].provider_account_id).toBe(t.account);
      });

      it("keeps a reconnect open while another profile is signed in, and touches no account", async () => {
        const key = uniqueKey();
        const t = await named({ member: `ACoAAother${key}`, slug: `other-${key}` }, true);
        const state = await connect.checkConnectLink(t.deps, t.actor, t.link.linkId);
        expect(state).toEqual({ status: "pending", error: expect.stringMatching(/Someone else is signed in/) });
        expect((await sql`select count(*)::int as n from linkedin_accounts where provider_account_id = ${t.account}`)[0].n).toBe(0);
        expect(t.cancelled).toEqual([]);
      });

      it("fails the link with the reason when a profile is refused, and cancels nothing that is not a session", async () => {
        const key = uniqueKey();
        const t = await named({ member: `ACoAAada${key}`, slug: `ada-${key}` });
        await sql`insert into linkedin_accounts (organization_id, provider, provider_account_id, linkedin_id, status) values (${t.f.id}, 'unipile', ${"u-" + key}, ${`ACoAAada${key}`}, 'connected')`;
        const state = await connect.checkConnectLink(t.deps, t.actor, t.link.linkId);
        expect(state.status).toBe("failed");
        expect(state.error).toMatch(/another LinkedIn provider/);
        expect(t.cancelled).toEqual([]);
      });
    });

    it("lets only one of two links at once through when the vendor allows one", async () => {
      const f = await org();
      const { drizzleLinkedInConnectStore: store } = await import("../drizzle-linkedin-connect-store");
      const now = new Date();
      const link = () => ({ id: crypto.randomUUID(), organizationId: f.id, providerName: `mia-${uniqueKey()}`, secretHash: "a".repeat(64), expiresAt: new Date(now.getTime() + 3_600_000), createdBy: null as unknown as string, ownerUserId: null, reconnectAccountId: null });
      const answers = await Promise.all([store.create(link(), { maxPending: 1, now }), store.create(link(), { maxPending: 1, now })]);
      expect(answers.filter(Boolean)).toHaveLength(1);
    });

    it("keeps the link for 48 hours, and names no callback", async () => {
      const t = await setup("pending", { member: "ACoAAx", slug: "x" });
      expect(t.link.notify).toBe(false);
      expect(t.link.expiresAt.getTime() - Date.now()).toBeGreaterThan(47 * 3_600_000);
      expect(await connect.checkConnectLink(t.deps, t.actor, t.link.linkId)).toEqual({ status: "pending", error: null });
      expect((await sql`select url, provider_account_id from linkedin_connect_links where id = ${t.link.linkId}`)[0]).toEqual({ url: null, provider_account_id: t.ref });
    });

    it("adds the account once the vendor says connected, with who signed in", async () => {
      const key = uniqueKey();
      const t = await setup("connected", { member: `ACoAAada${key}`, slug: `ada-${key}` });
      expect(await connect.checkConnectLink(t.deps, t.actor, t.link.linkId)).toEqual({ status: "completed", error: null });
      expect((await sql`select provider, provider_account_id, linkedin_id, name, is_premium, status from linkedin_accounts where organization_id = ${t.f.id}`)[0]).toEqual({ provider: "edges", provider_account_id: t.ref, linkedin_id: `ACoAAada${key}`, name: "Ada L", is_premium: true, status: "connected" });
      expect((await connect.checkConnectLink(t.deps, t.actor, t.link.linkId)).status).toBe("completed");
    });

    it("removes a new identity whose sign-in failed, so a second try is not refused for holding the same profile", async () => {
      const t = await setup("failed", { member: "ACoAAx", slug: "x" });
      expect((await connect.checkConnectLink(t.deps, t.actor, t.link.linkId)).status).toBe("failed");
      expect(t.cancelled).toEqual([t.ref]);
    });

    it("keeps a reconnect open while the vendor still calls the old sign-in failed, and keeps the account's identity", async () => {
      const t = await setup("failed", { member: "ACoAAx", slug: "x" });
      await sql`insert into linkedin_accounts (organization_id, provider, provider_account_id, linkedin_id, status) values (${t.f.id}, 'edges', ${t.ref}, ${"ACoAAold" + t.f.tag}, 'disconnected')`;
      expect(await connect.checkConnectLink(t.deps, t.actor, t.link.linkId)).toEqual({ status: "pending", error: null });
      expect(t.cancelled).toEqual([]);
    });

    it("gives an expired link's unused identity back when the next link is made, and keeps one an account uses", async () => {
      const t = await setup("pending", { member: "ACoAAx", slug: "x" });
      await sql`update linkedin_connect_links set expires_at = now() - interval '1 minute' where id = ${t.link.linkId}`;
      await connect.createConnectLink(t.deps, t.actor);
      expect(t.cancelled).toEqual([t.ref]);
      expect((await sql`select status from linkedin_connect_links where id = ${t.link.linkId}`)[0].status).toBe("expired");

      const used = await setup("pending", { member: "ACoAAy", slug: "y" });
      await sql`insert into linkedin_accounts (organization_id, provider, provider_account_id, linkedin_id, status) values (${used.f.id}, 'edges', ${used.ref}, ${"ACoAAy" + used.f.tag}, 'disconnected')`;
      await sql`update linkedin_connect_links set expires_at = now() - interval '1 minute' where id = ${used.link.linkId}`;
      await connect.createConnectLink(used.deps, used.actor);
      expect(used.cancelled).toEqual([]);
    });

    it("passes the organization's zone to a new link, and none to a reconnect", async () => {
      const t = await setup("pending", { member: "ACoAAx", slug: "x" });
      await sql`update organizations set timezone = 'Asia/Seoul' where id = ${t.f.id}`;
      const seen: Array<string | null> = [];
      const inner = (t.deps as unknown as { vendors: Array<{ gatewayFor: () => { createConnectLink: (input: { timeZone: string | null }) => Promise<unknown> } }> }).vendors[0].gatewayFor();
      inner.createConnectLink = async (input) => (seen.push(input.timeZone), { url: "https://login", account: t.ref });
      await connect.createConnectLink(t.deps, t.actor);
      const [{ id }] = await sql`insert into linkedin_accounts (organization_id, provider, provider_account_id, linkedin_id, status) values (${t.f.id}, 'edges', ${t.ref}, ${"ACoAAz" + t.f.tag}, 'disconnected') returning id`;
      await connect.createConnectLink(t.deps, t.actor, { reconnectAccountId: id });
      expect(seen).toEqual(["Asia/Seoul", null]);
    });

    it("refuses a profile already on another vendor, and fails the link", async () => {
      const key = uniqueKey();
      const t = await setup("connected", { member: `ACoAAada${key}`, slug: `ada-${key}` });
      await sql`insert into linkedin_accounts (organization_id, provider, provider_account_id, linkedin_id, status) values (${t.f.id}, 'unipile', ${"u-" + key}, ${`ACoAAada${key}`}, 'connected')`;
      const state = await connect.checkConnectLink(t.deps, t.actor, t.link.linkId);
      expect(state.status).toBe("failed");
      expect(state.error).toMatch(/another LinkedIn provider/);
      expect((await sql`select provider from linkedin_accounts where organization_id = ${t.f.id}`).map((r) => r.provider)).toEqual(["unipile"]);
      // Signed in, refused, and no row uses it: left behind, it would hold a seat and the profile at the vendor.
      expect(t.cancelled).toEqual([t.ref]);
    });

    it("keeps a reconnect open while someone else is signed in, so the right sign-in can still finish it", async () => {
      const key = uniqueKey();
      const t = await setup("connected", { member: `ACoAAother${key}`, slug: `other-${key}` });
      await sql`insert into linkedin_accounts (organization_id, provider, provider_account_id, linkedin_id, username, status) values (${t.f.id}, 'edges', ${t.ref}, ${`ACoAAowner${key}`}, ${`owner-${key}`}, 'connected')`;
      const state = await connect.checkConnectLink(t.deps, t.actor, t.link.linkId);
      expect(state).toEqual({ status: "pending", error: expect.stringMatching(/Someone else is signed in/) });
      expect(t.cancelled).toEqual([]);
      expect((await sql`select status from linkedin_accounts where provider_account_id = ${t.ref}`)[0].status).toBe("disconnected");
      expect((await sql`select status, last_error from linkedin_connect_links where id = ${t.link.linkId}`)[0]).toMatchObject({ status: "pending", last_error: expect.stringMatching(/Someone else/) });

      const inner = (t.deps as unknown as { vendors: Array<{ gatewayFor: () => FakeLinkedInGateway }> }).vendors[0].gatewayFor();
      inner.getOwnProfile = async () => ({ member: `ACoAAowner${key}`, publicSlug: `owner-${key}`, firstName: "Ada", lastName: "L", headline: null, location: null, pictureUrl: null, networkDistance: "unknown", isPremium: true });
      expect(await connect.checkConnectLink(t.deps, t.actor, t.link.linkId)).toEqual({ status: "completed", error: null });
      expect((await sql`select status from linkedin_accounts where provider_account_id = ${t.ref}`)[0].status).toBe("connected");
    });

    it("says what went wrong when the profile cannot be read, so the page can wait before spending another credit", async () => {
      const t = await setup("connected", { member: "ACoAAx", slug: "x" });
      const inner = (t.deps as unknown as { vendors: Array<{ gatewayFor: () => FakeLinkedInGateway }> }).vendors[0].gatewayFor();
      const { LinkedInGatewayError } = await import("../../application/linkedin-ports");
      inner.getOwnProfile = async () => {
        throw new LinkedInGatewayError("no id", "definite", "rejected");
      };
      expect(await connect.checkConnectLink(t.deps, t.actor, t.link.linkId)).toEqual({ status: "pending", error: "Edges refused the request. Check your Edges workspace." });
    });

    it("gives an expired link's identity back on the hourly sync, with no new link made", async () => {
      const t = await setup("pending", { member: "ACoAAx", slug: "x" });
      await sql`update linkedin_connect_links set expires_at = now() - interval '1 minute' where id = ${t.link.linkId}`;
      const { createLinkedInJobs } = await import("../../application/linkedin-jobs");
      const base = t.deps as unknown as { accounts: typeof accounts };
      const management = { ...(t.deps as object), accounts: { ...base.accounts, listCredentialedOrganizations: async () => [t.f.id] } };
      const slots = { claim: async () => ({ organizationId: t.f.id }), finish: async () => undefined };
      const [sync] = createLinkedInJobs({} as never, {} as never, {} as never, management as never, slots as never);
      await sync.run({ deadline: Date.now() + 60_000, now: () => new Date() });
      expect(t.cancelled).toEqual([t.ref]);
      expect((await sql`select status from linkedin_connect_links where id = ${t.link.linkId}`)[0].status).toBe("expired");
    });

    it("lists open links first, so one is still asked about however many links came after it", async () => {
      const t = await setup("pending", { member: "ACoAAx", slug: "x" });
      for (let i = 0; i < 5; i++) {
        await sql`insert into linkedin_connect_links (organization_id, provider_name, secret_hash, status, expires_at, created_at) values (${t.f.id}, ${"later-" + uniqueKey()}, ${"0".repeat(64)}, 'failed', now() + interval '1 hour', now() + interval '1 minute')`;
      }
      const { drizzleLinkedInConnectStore } = await import("../drizzle-linkedin-connect-store");
      const listed = await drizzleLinkedInConnectStore.listRecent(t.f.id, 5, new Date());
      expect(listed).toHaveLength(5);
      expect(listed[0]).toMatchObject({ id: t.link.linkId, status: "pending" });
    });

    it("removes a new identity on cancel, and keeps one an account uses", async () => {
      const fresh = await setup("pending", { member: "ACoAAx", slug: "x" });
      await connect.cancelConnectLink(fresh.deps, fresh.actor, fresh.link.linkId);
      expect(fresh.cancelled).toEqual([fresh.ref]);
      expect((await sql`select status from linkedin_connect_links where id = ${fresh.link.linkId}`)[0].status).toBe("failed");

      const used = await setup("pending", { member: "ACoAAy", slug: "y" });
      await sql`insert into linkedin_accounts (organization_id, provider, provider_account_id, linkedin_id, status) values (${used.f.id}, 'edges', ${used.ref}, ${"ACoAAy" + used.f.tag}, 'disconnected')`;
      await connect.cancelConnectLink(used.deps, used.actor, used.link.linkId);
      expect(used.cancelled).toEqual([]);
    });

    it("leaves the identity of a link a check completed a moment before the cancel", async () => {
      const t = await setup("pending", { member: "ACoAAx", slug: "x" });
      const closing = t.deps as unknown as { connectLinks: { fail: (id: string, error: string) => Promise<boolean> } };
      const deps = { ...(t.deps as object), connectLinks: { ...closing.connectLinks, fail: async () => false } };
      await connect.cancelConnectLink(deps as never, t.actor, t.link.linkId);
      expect(t.cancelled).toEqual([]);
    });

    it("refuses to reconnect an account left from another vendor", async () => {
      const t = await setup("pending", { member: "ACoAAx", slug: "x" });
      const old = await account(t.f, "unipile");
      await expect(connect.createConnectLink(t.deps, t.actor, { reconnectAccountId: old.id })).rejects.toThrow(/not on Edges/);
    });

    it("hides a link from another organization", async () => {
      const t = await setup("pending", { member: "ACoAAx", slug: "x" });
      const other = { ...t.actor, organizationId: (await org()).id };
      await expect(connect.checkConnectLink(t.deps, other, t.link.linkId)).rejects.toThrow(/not found/i);
    });
  });

  it("tells the reply path an account's vendor is gone", async () => {
    const f = await org();
    const a = await account(f, "unipile");
    await accounts.saveCredentials(f.id, { apiKey: "k", notifySecret: "s" }, EDGES);
    const { createLinkedInSentFinder } = await import("@/contexts/conversations/infrastructure/linkedin-sent-finder");
    const finder = createLinkedInSentFinder(composition.linkedinGateways());
    expect(await finder.available({ organizationId: f.id, accountId: a.id })).toBe(false);
  });
});
