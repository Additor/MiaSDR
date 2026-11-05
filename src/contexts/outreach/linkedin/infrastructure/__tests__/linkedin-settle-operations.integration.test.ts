import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import { LinkedInGatewayError, type LinkedInEngineDeps, type LinkedInInboundDeps } from "../../application/linkedin-ports";
import type { LinkedInSearchEngineDeps } from "../../application/linkedin-search-ports";
import type { LinkedInSettleDeps } from "../../application/settle-linkedin-operations";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [
  { stepNumber: 1, kind: "invitation", body: "Hi", waitDays: 0 },
  { stepNumber: 2, kind: "message", body: "Thanks", waitDays: 1 },
];

/**
 * A vendor that runs actions after it answered. Each case pins a rule of the settle job. The double-send ones matter most: a
 * failed read and an unconfirmed cancel must leave the send where it is. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("LinkedIn actions a vendor runs later", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let store: typeof import("../drizzle-linkedin-store").drizzleLinkedInStore;
  let openStore: typeof import("../drizzle-linkedin-open-operations-store").drizzleLinkedInOpenOperationStore;
  let searchStore: typeof import("../drizzle-linkedin-search-store").drizzleLinkedInSearchEngineStore;
  let batches: typeof import("../drizzle-linkedin-search-batch-store").drizzleLinkedInSearchBatchStore;
  let engine: typeof import("../../application/send-next-linkedin");
  let settle: typeof import("../../application/settle-linkedin-operations");
  let search: typeof import("../../application/run-linkedin-search");
  let replyStop: LinkedInEngineDeps["stopForReply"];
  let inbound: LinkedInInboundDeps;
  let sink: LinkedInSearchEngineDeps["sink"];
  const orgs: string[] = [];

  const deps = (gateway: FakeLinkedInGateway): LinkedInEngineDeps => ({ store, stopForReply: replyStop, gateways: gateway, clock: { now: () => new Date() }, random: () => 0 });
  const searchDeps = (gateway: FakeLinkedInGateway): LinkedInSearchEngineDeps => ({ store: searchStore, gateways: gateway, sink, clock: { now: () => new Date() }, random: () => 0 });
  const settleDeps = (gateway: FakeLinkedInGateway): LinkedInSettleDeps => ({ operations: openStore, engine: deps(gateway), search: searchDeps(gateway), inbound });
  const runSettle = (gateway: FakeLinkedInGateway) => settle.settleLinkedInOperations(settleDeps(gateway), Date.now() + 30_000);

  function asyncGateway() {
    const gateway = new FakeLinkedInGateway();
    gateway.asyncMode = true;
    return gateway;
  }

  async function org() {
    const [{ id }] = await sql`insert into organizations (name, slug) values ('S', ${"settle-" + uniqueKey()}) returning id`;
    orgs.push(id);
    return id as string;
  }

  async function account(organizationId: string, over: { search?: number } = {}) {
    const ref = `acct-${uniqueKey()}`;
    const [{ id }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status, daily_invite_limit, working_hours, search_leads_today, search_day)
      values (${organizationId}, ${ref}, ${"ACo-" + ref}, ${"o-" + ref}, 'connected', 30, ${sql.json({ timeZone: "UTC", days: ALL_DAY } as never)}, ${over.search ?? 0}, ${new Date().toISOString().slice(0, 10)})
      returning id`;
    return { id: id as string, ref };
  }

  async function lead(organizationId: string, accountId: string, state: "invite" | "message" | "lookup", over: { profileUrl?: string } = {}) {
    const member = state === "lookup" ? null : `ACoAAlead${uniqueKey().replaceAll("-", "")}`;
    const slug = over.profileUrl ? null : `lead-${uniqueKey()}`;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${organizationId}, 'linkedin', 'c', 'active', ${sql.json(STEPS as never)}) returning id`;
    const [{ id: person }] = await sql`insert into people (organization_id, linkedin_slug, first_name) values (${organizationId}, ${slug}, 'Ada') returning id`;
    const message = state === "message";
    const [{ id: enrollment }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, next_send_at, linkedin_account_id)
      values (${organizationId}, ${campaign}, ${person}, 'linkedin', ${message ? "active" : "pending"}, ${message ? 1 : 0}, ${message ? new Date(Date.now() - 60_000) : null}, ${accountId}) returning id`;
    await sql`
      insert into linkedin_enrollment_details (enrollment_id, organization_id, provider_id, connection_state, profile_url)
      values (${enrollment}, ${organizationId}, ${member}, ${message ? "connected" : "none"}, ${over.profileUrl ?? null})`;
    return { enrollment: enrollment as string, campaign: campaign as string, person: person as string, member, slug };
  }

  async function openSearch(organizationId: string, over: { maxResults?: number } = {}) {
    const [{ id: batch }] = await sql`insert into linkedin_search_batches (organization_id, name, kind) values (${organizationId}, 'b', 'bulk') returning id`;
    const [{ id }] = await sql`insert into linkedin_search_queries (organization_id, batch_id, url, max_results) values (${organizationId}, ${batch}, ${"https://www.linkedin.com/search/results/people/?keywords=" + uniqueKey()}, ${over.maxResults ?? 100}) returning id`;
    return { id: id as string, batch: batch as string };
  }

  const row = async (kind: string, subject: string) => (await sql`select * from linkedin_open_operations where kind = ${kind} and subject_id = ${subject}`)[0];
  const send = async (enrollment: string, step = 1) => (await sql`select * from sends where enrollment_id = ${enrollment} and step_number = ${step}`)[0];
  const enrollmentOf = async (id: string) => (await sql`select * from campaign_enrollments where id = ${id}`)[0];
  const detailsOf = async (id: string) => (await sql`select * from linkedin_enrollment_details where enrollment_id = ${id}`)[0];
  const accountOf = async (id: string) => (await sql`select * from linkedin_accounts where id = ${id}`)[0];
  const queryOf = async (id: string) => (await sql`select * from linkedin_search_queries where id = ${id}`)[0];
  const age = (minutes: number) => sql`update linkedin_open_operations set submitted_at = now() - make_interval(mins => ${minutes})`;
  /** Lets the account act again, as the pacing gap passing would. */
  const pass = (accountId: string) => sql`update linkedin_accounts set next_allowed_run_at = null where id = ${accountId}`;

  beforeAll(async () => {
    const linkedinStore = await import("../drizzle-linkedin-store");
    store = linkedinStore.drizzleLinkedInStore;
    ({ drizzleLinkedInOpenOperationStore: openStore } = await import("../drizzle-linkedin-open-operations-store"));
    ({ drizzleLinkedInSearchEngineStore: searchStore } = await import("../drizzle-linkedin-search-store"));
    ({ drizzleLinkedInSearchBatchStore: batches } = await import("../drizzle-linkedin-search-batch-store"));
    engine = await import("../../application/send-next-linkedin");
    settle = await import("../../application/settle-linkedin-operations");
    search = await import("../../application/run-linkedin-search");
    const { contactStop, inboxFiling } = await import("@/composition/inbox-filing");
    replyStop = linkedinStore.createLinkedInReplyStop(contactStop);
    ({ searchLeadSink: sink } = await import("../search-lead-sink"));
    const { createDrizzleLinkedInInboundStore } = await import("../drizzle-linkedin-inbound-store");
    inbound = {
      store: createDrizzleLinkedInInboundStore(inboxFiling),
      clock: { now: () => new Date() },
      parse: (payload) => payload as never,
      eventKey: (event) => (event.type === "message_received" ? `settle-test:${event.account}:${event.messageId}` : null),
    };
  });

  afterEach(() => sql`delete from linkedin_open_operations where organization_id = any(${orgs})`);
  afterAll(() => dropOrgs(sql, orgs.map((organizationId) => ({ organizationId }))));

  describe("an invitation", () => {
    async function submitted(gateway = asyncGateway()) {
      const organization = await org();
      const a = await account(organization);
      const l = await lead(organization, a.id, "invite");
      await sql`update linkedin_enrollment_details set provider_id = ${"ACoAAx" + uniqueKey().replaceAll("-", "")} where enrollment_id = ${l.enrollment}`;
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("submitted");
      return { gateway, organization, a, l, sendId: (await send(l.enrollment)).id as string };
    }

    it("stays sending and holds the account until the vendor finishes it", async () => {
      const { gateway, a, l, sendId } = await submitted();
      expect((await send(l.enrollment)).status).toBe("sending");
      expect(await row("invitation", sendId)).toMatchObject({ provider_account_ref: a.ref });
      await pass(a.id);
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("idle");

      await runSettle(gateway);
      expect((await send(l.enrollment)).status).toBe("sending");

      await gateway.finishOperations();
      expect((await runSettle(gateway)).settled).toBe(1);
      expect((await send(l.enrollment)).status).toBe("sent");
      expect((await detailsOf(l.enrollment)).connection_state).toBe("request_sent");
      expect(await row("invitation", sendId)).toBeUndefined();
    });

    it("is left alone by reconciling while the vendor runs it", async () => {
      const { gateway, l, sendId } = await submitted();
      await sql`update sends set claimed_at = now() - interval '2 hours' where id = ${sendId}`;
      const report = await engine.reconcileLinkedInSends(deps(gateway));
      expect(report.checked).toBe(0);
      expect((await send(l.enrollment)).status).toBe("sending");
    });

    it("keeps its attempt when a read fails, however often", async () => {
      const { gateway, a, l, sendId } = await submitted();
      gateway.progressOutage = new LinkedInGatewayError("Slow down.", "definite", "rate_limited");
      await age(120);
      await runSettle(gateway);
      const held = await send(l.enrollment);
      expect(held).toMatchObject({ status: "sending", attempt: 1 });
      expect(await row("invitation", sendId)).toBeDefined();
      expect((await accountOf(a.id)).limit_reached_until).toBeNull();
      expect(gateway.cancelled).toHaveLength(0);
    });

    it("goes back when the vendor held it and the cancel is confirmed, and the account waits", async () => {
      const { gateway, a, l } = await submitted();
      gateway.holdOperations();
      await runSettle(gateway);
      expect(await send(l.enrollment)).toMatchObject({ status: "failed", attempt: 0 });
      expect((await accountOf(a.id)).limit_reached_until.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    });

    it("stays open when a cancel is not confirmed", async () => {
      const { gateway, l, sendId } = await submitted();
      gateway.holdOperations();
      gateway.cancelAnswer = () => {
        throw new Error("no answer");
      };
      await runSettle(gateway);
      expect(await send(l.enrollment)).toMatchObject({ status: "sending", attempt: 1 });
      expect(await row("invitation", sendId)).toBeDefined();
    });

    it("counts an attempt after the time limit, so a lead that keeps timing out ends", async () => {
      const { gateway, l } = await submitted();
      await age(60);
      await runSettle(gateway);
      expect(await send(l.enrollment)).toMatchObject({ status: "failed", attempt: 1 });
      expect((await enrollmentOf(l.enrollment)).next_send_at).not.toBeNull();
    });

    it("takes the outcome when a cancel comes too late", async () => {
      const { gateway, l } = await submitted();
      await age(60);
      await gateway.finishOperations();
      gateway.openOperations.forEach((open) => {
        const answered = open.outcome;
        open.outcome = null;
        gateway.cancelAnswer = () => {
          open.outcome = answered;
          return "already_finished";
        };
      });
      await runSettle(gateway);
      expect((await send(l.enrollment)).status).toBe("sent");
    });

    it("is cancelled and given back when the lead stops", async () => {
      const { gateway, l } = await submitted();
      await sql`update campaign_enrollments set status = 'replied' where id = ${l.enrollment}`;
      await runSettle(gateway);
      expect(gateway.cancelled).toHaveLength(1);
      expect(await send(l.enrollment)).toMatchObject({ status: "failed", attempt: 0 });
      expect((await enrollmentOf(l.enrollment)).status).toBe("replied");
    });

    it("reads a refusal as a refusal", async () => {
      const gateway = asyncGateway();
      gateway.inviteBehavior = () => ({ refuse: "already_invited" });
      const { l } = await submitted(gateway);
      await gateway.finishOperations();
      await runSettle(gateway);
      expect((await send(l.enrollment)).status).toBe("sent");
    });

    it("closes by its kind after a day of failed reads", async () => {
      const { gateway, l, sendId } = await submitted();
      gateway.progressOutage = new LinkedInGatewayError("Gone.", "unknown", "unavailable");
      await age(24 * 60);
      await runSettle(gateway);
      expect(await row("invitation", sendId)).toBeUndefined();
      expect(await send(l.enrollment)).toMatchObject({ status: "failed", attempt: 1 });
    });
  });

  describe("a message", () => {
    async function submitted(gateway = asyncGateway()) {
      const organization = await org();
      const a = await account(organization);
      const l = await lead(organization, a.id, "message");
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("submitted");
      return { gateway, organization, a, l, sendId: (await send(l.enrollment, 2)).id as string };
    }

    it("goes out once when a read fails between the submit and the finish", async () => {
      const { gateway, a, l } = await submitted();
      gateway.progressOutage = new LinkedInGatewayError("Slow down.", "definite", "rate_limited");
      await runSettle(gateway);
      gateway.progressOutage = null;
      await pass(a.id);
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("idle");
      await gateway.finishOperations();
      await runSettle(gateway);
      expect(gateway.messages).toHaveLength(1);
      expect(await send(l.enrollment, 2)).toMatchObject({ status: "sent", attempt: 1 });
    });

    it("waits for a person after the time limit, and nothing resends it", async () => {
      const { gateway, l, sendId } = await submitted();
      await age(60);
      await runSettle(gateway);
      expect((await send(l.enrollment, 2)).status).toBe("unknown");
      expect(await row("message", sendId)).toBeUndefined();
    });

    it("settles when the step was edited away since the submit", async () => {
      const { gateway, l } = await submitted();
      await sql`update campaigns set steps = ${sql.json([STEPS[0]] as never)} where id = ${l.campaign}`;
      await gateway.finishOperations();
      expect((await runSettle(gateway)).failed).toBe(0);
      expect((await send(l.enrollment, 2)).status).toBe("sent");
    });

    it("cancels and closes when the send's lead was purged", async () => {
      const { gateway, sendId } = await submitted();
      await sql`update sends set status = 'failed' where id = ${sendId}`;
      await sql`delete from sends where id = ${sendId}`;
      await runSettle(gateway);
      expect(gateway.cancelled).toHaveLength(1);
      expect(await row("message", sendId)).toBeUndefined();
    });

    it("moves to a person when a vendor cannot rule a lost send out", async () => {
      const organization = await org();
      const a = await account(organization);
      const l = await lead(organization, a.id, "message");
      const gateway = new FakeLinkedInGateway();
      gateway.messageBehavior = () => "timeout-lost";
      gateway.findSentMessage = (async () => "ask_a_person") as unknown as typeof gateway.findSentMessage;
      await engine.runNextLinkedInAction(deps(gateway), a.id);
      await sql`update sends set claimed_at = now() - interval '2 hours', status = 'sending' where enrollment_id = ${l.enrollment}`;
      await engine.reconcileLinkedInSends(deps(gateway));
      expect((await send(l.enrollment, 2)).status).toBe("unknown");
      expect(gateway.messages).toHaveLength(0);
    });
  });

  describe("a lookup", () => {
    async function submitted(gateway = asyncGateway(), profileUrl?: string) {
      const organization = await org();
      const a = await account(organization);
      const l = await lead(organization, a.id, "lookup", profileUrl ? { profileUrl } : {});
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("submitted");
      return { gateway, organization, a, l };
    }
    const SALES_NAV = "https://www.linkedin.com/sales/lead/ACwAAAbcdefghijklmnopqrstuvwxyz,NAME_SEARCH,abc";

    it("writes what the vendor found, with the member URN", async () => {
      const gateway = asyncGateway();
      const slug = `known-${uniqueKey()}`;
      const { a, l } = await submitted(gateway, `https://www.linkedin.com/in/${slug}`);
      gateway.profiles.set(slug, { member: "ACoAAfound", publicSlug: slug, firstName: "Ada", lastName: null, headline: null, location: null, pictureUrl: null, networkDistance: "second", isPremium: null, memberUrn: "urn:li:member:7" });
      await gateway.finishOperations();
      await runSettle(gateway);
      expect(await detailsOf(l.enrollment)).toMatchObject({ provider_id: "ACoAAfound", member_urn: "urn:li:member:7" });
      expect((await enrollmentOf(l.enrollment)).linkedin_account_id).toBe(a.id);
    });

    it("does not pin a lead that stopped while it ran", async () => {
      const gateway = asyncGateway();
      const { a, l } = await submitted(gateway);
      const otherAccountless = l.enrollment;
      await sql`update campaign_enrollments set status = 'removed', linkedin_account_id = null where id = ${otherAccountless}`;
      await gateway.finishOperations();
      await runSettle(gateway);
      expect((await detailsOf(l.enrollment)).provider_id).toBeNull();
      expect((await enrollmentOf(l.enrollment)).linkedin_account_id).not.toBe(a.id);
    });

    it("leaves the fallback to a claim, so every claim gate applies", async () => {
      const gateway = asyncGateway();
      gateway.autoProfiles = false;
      const { a, l } = await submitted(gateway, SALES_NAV);
      await gateway.finishOperations();
      await runSettle(gateway);
      expect(gateway.openOperations.size).toBe(1);
      expect((await detailsOf(l.enrollment)).resolve_next_api).toBe("sales_navigator");

      await sql`update linkedin_accounts set limit_reached_until = now() + interval '1 hour' where id = ${a.id}`;
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("idle");

      await sql`update linkedin_accounts set limit_reached_until = null, next_allowed_run_at = null where id = ${a.id}`;
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("submitted");
      await gateway.finishOperations();
      expect(gateway.profileCalls.at(-1)?.linkedinApi).toBe("sales_navigator");
    });

    it("ends a fallback the account has no product for with retries left", async () => {
      const gateway = asyncGateway();
      gateway.autoProfiles = false;
      gateway.profileFailure = (call) => (call.linkedinApi ? "insufficient_privileges" : "not_found");
      const { a, l } = await submitted(gateway, SALES_NAV);
      await gateway.finishOperations();
      await runSettle(gateway);
      await pass(a.id);
      await engine.runNextLinkedInAction(deps(gateway), a.id);
      await gateway.finishOperations();
      await runSettle(gateway);
      expect(await detailsOf(l.enrollment)).toMatchObject({ resolve_retry_count: 1, resolve_next_api: null });
      expect((await detailsOf(l.enrollment)).resolve_last_error).toContain("no Sales Navigator");
    });

    it("gives the person the slug a product lookup named, and looks them up the classic way", async () => {
      const gateway = asyncGateway();
      const slug = `named-${uniqueKey()}`;
      const { a, l } = await submitted(gateway, SALES_NAV);
      for (const open of gateway.openOperations.values()) open.run = async () => ({ lookAgain: slug });
      await gateway.finishOperations();
      await runSettle(gateway);
      expect((await sql`select linkedin_slug from people where id = ${l.person}`)[0].linkedin_slug).toBe(slug);
      await pass(a.id);
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("submitted");
      await gateway.finishOperations();
      expect(gateway.profileCalls.at(-1)).toMatchObject({ identifier: slug, linkedinApi: null });
    });

    it("counts a failure after the time limit, so the retries end it", async () => {
      const { gateway, l } = await submitted();
      await age(60);
      await runSettle(gateway);
      expect((await detailsOf(l.enrollment)).resolve_retry_count).toBe(1);
    });
  });

  describe("a search", () => {
    // The search job claims across organizations, so what an earlier case left queued would answer first.
    beforeEach(() => sql`delete from linkedin_search_queries where organization_id = any(${orgs})`);

    const people = (n: number) => ({
      items: Array.from({ length: n }, (_, i) => {
        const slug = `found-${uniqueKey()}-${i}`;
        return { identifier: slug, profileUrl: `https://www.linkedin.com/in/${slug}`, name: "N", headline: null, location: null, networkDistance: null, raw: {} };
      }),
      nextCursor: null,
      totalEstimate: null,
    });

    async function submitted(gateway = asyncGateway(), over: { maxResults?: number; used?: number } = {}) {
      const organization = await org();
      const a = await account(organization, { search: over.used ?? 0 });
      const s = await openSearch(organization, { maxResults: over.maxResults ?? 100 });
      expect((await search.runNextSearchPage(searchDeps(gateway))).kind).toBe("submitted");
      return { gateway, organization, a, s };
    }

    it("reads once, and holds the allowance until it finishes", async () => {
      const gateway = asyncGateway();
      gateway.searchPages = [people(30)];
      const { a, s } = await submitted(gateway);
      expect(gateway.searchLimits.at(-1)).toBe(100);
      expect((await accountOf(a.id)).search_leads_today).toBe(100);
      expect(await row("search", s.id)).toMatchObject({ row_limit: 100 });

      await gateway.finishOperations();
      await runSettle(gateway);
      expect(await queryOf(s.id)).toMatchObject({ status: "completed", leads_fetched: 30, last_error: null });
      expect((await accountOf(a.id)).search_leads_today).toBe(30);
    });

    it("stops at the day's allowance and says so", async () => {
      const gateway = asyncGateway();
      gateway.searchPages = [people(300)];
      const { a, s } = await submitted(gateway, { maxResults: 2500, used: 100 });
      expect(gateway.searchLimits.at(-1)).toBe(300);
      await gateway.finishOperations();
      await runSettle(gateway);
      const done = await queryOf(s.id);
      expect(done.status).toBe("completed");
      expect(done.last_error).toContain("Read 300 people");
      expect((await accountOf(a.id)).search_leads_today).toBe(400);
    });

    it("waits for tomorrow rather than read a handful", async () => {
      const gateway = asyncGateway();
      const organization = await org();
      await account(organization, { search: 395 });
      const s = await openSearch(organization, { maxResults: 100 });
      expect((await search.runNextSearchPage(searchDeps(gateway))).kind).toBe("paused");
      expect(gateway.searchLimits).toHaveLength(0);
      const waiting = await queryOf(s.id);
      expect(waiting.next_page_at.getTime()).toBeGreaterThan(Date.now());
      expect(waiting.last_error).toContain("tomorrow");
    });

    it("gives an account with an open action nothing else, and many waiting searches do not block the rest", async () => {
      const gateway = asyncGateway();
      const organization = await org();
      await account(organization);
      for (let i = 0; i < 12; i += 1) await openSearch(organization);
      expect((await search.runNextSearchPage(searchDeps(gateway))).kind).toBe("submitted");
      const other = await org();
      await account(other);
      const later = await openSearch(other);
      expect((await search.runNextSearchPage(searchDeps(gateway))).kind).toBe("submitted");
      expect(await row("search", later.id)).toBeDefined();
    });

    it("gives the allowance back on a refusal, and keeps it charged on a timeout", async () => {
      const refused = asyncGateway();
      refused.searchBehavior = () => ({ refuse: "rejected" });
      const first = await submitted(refused);
      await refused.finishOperations();
      await runSettle(refused);
      expect((await queryOf(first.s.id)).status).toBe("failed");
      expect((await accountOf(first.a.id)).search_leads_today).toBe(0);

      const slow = await submitted();
      await age(60);
      await runSettle(slow.gateway);
      const after = await queryOf(slow.s.id);
      expect(after).toMatchObject({ status: "running", failures: 1 });
      expect((await accountOf(slow.a.id)).search_leads_today).toBe(100);
    });

    it("cancels a paused search, keeps it charged, and refuses to remove it while the read is open", async () => {
      const { gateway, a, s } = await submitted();
      await sql`update linkedin_search_queries set status = 'paused' where id = ${s.id}`;
      const actor = { actorUserId: null as unknown as string };
      await sql`update linkedin_open_operations set checked_at = null`;
      const refused = await batches.removeQueries((await queryOf(s.id)).organization_id, s.batch, [s.id], actor);
      expect(refused).toMatchObject({ ok: false, reason: "running" });

      await runSettle(gateway);
      expect(gateway.cancelled).toHaveLength(1);
      expect(await row("search", s.id)).toBeUndefined();
      expect((await queryOf(s.id)).status).toBe("paused");
      expect((await accountOf(a.id)).search_leads_today).toBe(100);
    });
  });

  describe("after a reconnect", () => {
    async function gapped() {
      const gateway = asyncGateway();
      const organization = await org();
      const a = await account(organization);
      const l = await lead(organization, a.id, "message");
      await sql`update linkedin_accounts set inbox_gap_until = now() where id = ${a.id}`;
      return { gateway, organization, a, l };
    }

    it("reads the lead's thread before its next message", async () => {
      const { gateway, a, l } = await gapped();
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("submitted");
      expect(gateway.threadChecks).toHaveLength(1);
      expect(await send(l.enrollment, 2)).toBeUndefined();

      await gateway.finishOperations();
      await runSettle(gateway);
      expect((await detailsOf(l.enrollment)).reply_checked_at).not.toBeNull();

      await pass(a.id);
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("submitted");
      expect((await send(l.enrollment, 2)).status).toBe("sending");
      expect(gateway.threadChecks).toHaveLength(1);
    });

    it("stops the lead when the thread holds a reply, and sends nothing", async () => {
      const { gateway, organization, a, l } = await gapped();
      gateway.threadDeliveries = [{ type: "message_received", account: a.ref, chat: "chat-1", messageId: `m-${uniqueKey()}`, text: "No thanks", fromAccountOwner: false, counterparty: l.member, counterpartyName: "Ada", counterpartyProfileUrl: null, sentAt: new Date().toISOString() }];
      await engine.runNextLinkedInAction(deps(gateway), a.id);
      await gateway.finishOperations();
      await runSettle(gateway);
      expect((await enrollmentOf(l.enrollment)).status).toBe("replied");
      await pass(a.id);
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("idle");
      expect(gateway.messages).toHaveLength(0);
      expect(organization).toBeTruthy();
    });

    it("holds the lead when a look cannot finish, so others go first and nothing goes out unread", async () => {
      const { gateway, a, l } = await gapped();
      await engine.runNextLinkedInAction(deps(gateway), a.id);
      await age(60);
      await runSettle(gateway);
      expect((await detailsOf(l.enrollment)).reply_checked_at).toBeNull();
      expect((await enrollmentOf(l.enrollment)).next_send_at.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
      await pass(a.id);
      expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("idle");
      expect(await send(l.enrollment, 2)).toBeUndefined();
    });

    it("reads again when the thread cannot be read yet", async () => {
      const { gateway, a, l } = await gapped();
      await engine.runNextLinkedInAction(deps(gateway), a.id);
      await gateway.finishOperations();
      gateway.operations!.readThread = async () => {
        throw new Error("no answer");
      };
      expect((await runSettle(gateway)).failed).toBe(1);
      expect((await detailsOf(l.enrollment)).reply_checked_at).toBeNull();
      expect((await sql`select count(*)::int as n from linkedin_open_operations where linkedin_account_id = ${a.id}`)[0].n).toBe(1);
    });
  });

  describe("an acceptance that names no member id", () => {
    async function waiting() {
      const organization = await org();
      const a = await account(organization);
      const l = await lead(organization, a.id, "invite");
      const member = `ACoAAw${uniqueKey().replaceAll("-", "")}`;
      await sql`update linkedin_enrollment_details set provider_id = ${member}, connection_state = 'request_sent', member_urn = ${"urn:li:member:" + member} where enrollment_id = ${l.enrollment}`;
      await sql`update campaign_enrollments set status = 'active', current_step = 1 where id = ${l.enrollment}`;
      return { organization, a, l, member };
    }

    it("finds the lead by member URN and takes the member id the lookup found", async () => {
      const { organization, a, l, member } = await waiting();
      const result = await inbound.store.apply(organization, { type: "connection_accepted", account: a.ref, member: null, memberUrn: `urn:li:member:${member}`, slug: null, name: null, profileUrl: null }, new Date());
      expect(result.note).toContain("Accepted: 1");
      expect((await detailsOf(l.enrollment)).connection_state).toBe("connected");
      expect((await sql`select provider_id from linkedin_connections where linkedin_account_id = ${a.id}`)[0].provider_id).toBe(member);
    });

    it("finds the lead by public slug", async () => {
      const { organization, a, l } = await waiting();
      await inbound.store.apply(organization, { type: "connection_accepted", account: a.ref, member: null, memberUrn: null, slug: l.slug, name: null, profileUrl: null }, new Date());
      expect((await detailsOf(l.enrollment)).connection_state).toBe("connected");
    });

    it("says so when nobody matches, and files nothing", async () => {
      const { organization, a, l } = await waiting();
      const result = await inbound.store.apply(organization, { type: "connection_accepted", account: a.ref, member: null, memberUrn: "urn:li:member:0", slug: null, name: null, profileUrl: null }, new Date());
      expect(result.note).toContain("No lead was waiting");
      expect((await detailsOf(l.enrollment)).connection_state).toBe("request_sent");
      expect(await sql`select 1 from linkedin_connections where linkedin_account_id = ${a.id}`).toHaveLength(0);
    });
  });

  it("does not let one failing action stop the rest", async () => {
    const gateway = asyncGateway();
    const first = await org();
    const a = await account(first);
    const bad = await lead(first, a.id, "message");
    await engine.runNextLinkedInAction(deps(gateway), a.id);
    const second = await org();
    const b = await account(second);
    const good = await lead(second, b.id, "message");
    await engine.runNextLinkedInAction(deps(gateway), b.id);
    await gateway.finishOperations();
    const failing = { ...store, markSent: async (claim: Parameters<typeof store.markSent>[0], ...rest: [Parameters<typeof store.markSent>[1], Date]) => {
      if (claim.enrollmentId === bad.enrollment) throw new Error("boom");
      return store.markSent(claim, ...rest);
    } };
    const report = await settle.settleLinkedInOperations({ ...settleDeps(gateway), engine: { ...deps(gateway), store: failing } }, Date.now() + 30_000);
    expect(report.failed).toBe(1);
    expect((await send(good.enrollment, 2)).status).toBe("sent");
  });

  it("names a vendor that answers at once no differently than before", async () => {
    const organization = await org();
    const a = await account(organization);
    const l = await lead(organization, a.id, "message");
    const gateway = new FakeLinkedInGateway();
    expect(gateway.operations).toBeUndefined();
    expect((await engine.runNextLinkedInAction(deps(gateway), a.id)).kind).toBe("sent");
    expect((await send(l.enrollment, 2)).status).toBe("sent");
  });
});
