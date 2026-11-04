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
      expect(await mgmt.syncWith(deps, f.id, gateway as never)).toMatchObject({ added: 0, updated: 1, changes: [{ ref: known.ref, to: "disconnected" }] });
      expect(asked).toEqual([[known.ref]]);
      const rows = await sql`select provider, status from linkedin_accounts where organization_id = ${f.id} order by provider`;
      expect(rows).toEqual([{ provider: "edges", status: "disconnected" }, { provider: "unipile", status: "connected" }]);
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
      await poll.pollLinkedInInbound(failing(new LinkedInGatewayError("signed out", "definite", "auth")), far());
      expect((await sql`select status from linkedin_accounts where id = ${a.id}`)[0].status).toBe("disconnected");
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
      const vendor = { ...edgesVendor.createEdgesVendor(), gatewayFor: () => gateway, connectSession: { status: async () => session, cancel: async () => { cancelled.push(created.account); } } };
      const cancelled: string[] = [];
      const { drizzleLinkedInConnectStore } = await import("../drizzle-linkedin-connect-store");
      const { auditSink } = await import("@/contexts/tenancy/infrastructure/audit");
      const deps = { accounts, vendors: [vendor], appUrl: "https://app.test", now: () => new Date(), audit: auditSink, connectLinks: drizzleLinkedInConnectStore };
      const link = await connect.createConnectLink(deps as never, actor);
      return { f, actor, deps: deps as never, link, ref: created.account, cancelled };
    };

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

    it("refuses a profile already on another vendor, and fails the link", async () => {
      const key = uniqueKey();
      const t = await setup("connected", { member: `ACoAAada${key}`, slug: `ada-${key}` });
      await sql`insert into linkedin_accounts (organization_id, provider, provider_account_id, linkedin_id, status) values (${t.f.id}, 'unipile', ${"u-" + key}, ${`ACoAAada${key}`}, 'connected')`;
      const state = await connect.checkConnectLink(t.deps, t.actor, t.link.linkId);
      expect(state.status).toBe("failed");
      expect(state.error).toMatch(/another LinkedIn provider/);
      expect((await sql`select provider from linkedin_accounts where organization_id = ${t.f.id}`).map((r) => r.provider)).toEqual(["unipile"]);
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
