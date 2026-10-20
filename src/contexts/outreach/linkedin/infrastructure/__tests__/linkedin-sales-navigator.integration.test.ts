import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { LinkedInEngineDeps } from "../../application/linkedin-ports";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [{ stepNumber: 1, kind: "invitation", body: "Hi {{firstName}}", waitDays: 0 }];
const SN = (id: string) => `https://www.linkedin.com/sales/lead/${id},NAME_SEARCH,abc`;
const COLLISION = "This LinkedIn profile already belongs to another lead in your organization.";

describeDb("linkedin sales navigator identity", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let engine: typeof import("../../application/send-next-linkedin");
  let store: typeof import("../drizzle-linkedin-store").drizzleLinkedInStore;
  let campaignStore: typeof import("../drizzle-linkedin-campaign-store").drizzleLinkedInCampaignStore;
  let enrollPeople: typeof import("../drizzle-linkedin-campaign-store").enrollPeople;
  let importLeads: typeof import("@/contexts/leads/application/import-leads").importLeads;
  let leadStore: typeof import("@/contexts/leads/infrastructure/drizzle-lead-store").drizzleLeadStore;
  let importFoundPeople: typeof import("@/contexts/leads/application/found-people").importFoundPeople;
  let foundStore: typeof import("@/contexts/leads/infrastructure/drizzle-found-people-store").drizzleFoundPeopleStore;
  const cleanup: string[] = [];
  let user = "";

  let current = new Date("2026-10-14T10:00:00Z");
  const clock = { now: () => current };
  const deps = (gateway: FakeLinkedInGateway): LinkedInEngineDeps => ({ store, gateways: gateway, clock, random: () => 0 });

  async function fixture() {
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('SN', ${"sn-" + tag}) returning id`;
    cleanup.push(org);
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status, daily_invite_limit, working_hours)
      values (${org}, ${"acct-" + tag}, ${"ACo-owner-" + tag}, ${"owner-" + tag}, 'connected', 20, ${sql.json({ timeZone: "UTC", days: ALL_DAY } as never)})
      returning id`;
    const [{ id: campaign }] = await sql`
      insert into campaigns (organization_id, channel, name, status, steps) values (${org}, 'linkedin', 'c', 'active', ${sql.json(STEPS as never)}) returning id`;
    return { org, account, campaign, tag };
  }

  const person = async (org: string, v: { slug?: string | null; url?: string | null; member?: string | null; email?: string | null }) =>
    (
      await sql`insert into people (organization_id, linkedin_slug, linkedin_url, email, first_name, raw)
        values (${org}, ${v.slug ?? null}, ${v.url ?? null}, ${v.email ?? null}, null, ${v.member ? sql.json({ linkedin_member_id: v.member } as never) : null}) returning id`
    )[0].id as string;
  const personRow = async (id: string) => (await sql`select * from people where id = ${id}`)[0];
  const enrollmentOf = async (campaign: string, personId: string) =>
    (await sql`select e.*, d.profile_url, d.provider_id, d.resolve_last_error from campaign_enrollments e join linkedin_enrollment_details d on d.enrollment_id = e.id where e.campaign_id = ${campaign} and e.person_id = ${personId}`)[0];

  /** Runs one action per call; the clock moves past the account's pacing gap each time. */
  async function resolveNext(gateway: FakeLinkedInGateway, f: { account: string }) {
    current = new Date(current.getTime() + 60 * 60_000);
    return engine.runNextLinkedInAction(deps(gateway), f.account);
  }

  beforeAll(async () => {
    engine = await import("../../application/send-next-linkedin");
    ({ drizzleLinkedInStore: store } = await import("../drizzle-linkedin-store"));
    ({ drizzleLinkedInCampaignStore: campaignStore, enrollPeople } = await import("../drizzle-linkedin-campaign-store"));
    ({ importLeads } = await import("@/contexts/leads/application/import-leads"));
    ({ drizzleLeadStore: leadStore } = await import("@/contexts/leads/infrastructure/drizzle-lead-store"));
    ({ importFoundPeople } = await import("@/contexts/leads/application/found-people"));
    ({ drizzleFoundPeopleStore: foundStore } = await import("@/contexts/leads/infrastructure/drizzle-found-people-store"));
    [{ id: user }] = await sql`insert into users (name, email) values ('U', ${uniqueKey() + "@sn.test"}) returning id`;
  });

  afterAll(async () => {
    await dropOrgs(sql, cleanup.map((organizationId) => ({ organizationId })), user ? [user] : []);
    await sql.end();
  });

  it("enrolls a Sales Navigator lead in both forms, and counts only people with no profile at all as skipped", async () => {
    const f = await fixture();
    const sn = await person(f.org, { url: SN("ACwAAAbCdEfGhIj"), email: "sn@x.test" });
    const rec = await person(f.org, { url: "https://www.linkedin.com/talent/hire/42/profile/ACwAAAzzzzzzzzz" });
    const bare = await person(f.org, { member: "ACwAAAmemberOnly1" });
    const classic = await person(f.org, { slug: "classic-one", url: "https://www.linkedin.com/in/classic-one/" });
    const junk = [
      await person(f.org, { url: "https://www.linkedin.com/sales/lead/ACwAAA" }),
      await person(f.org, { url: "https://www.linkedin.com/company/acme/" }),
      await person(f.org, { url: "https://example.com/sales/lead/ACwAAAbCdEfGhIj" }),
      await person(f.org, { email: "nothing@x.test" }),
    ];

    const result = await campaignStore.enroll(f.org, f.campaign, { limit: 100 });
    expect(result).toMatchObject({ requested: 8, added: 4, skippedNoProfile: 4, skippedMissingIdentity: 4, alreadyEnrolled: 0 });

    expect((await enrollmentOf(f.campaign, sn)).profile_url).toBe(SN("ACwAAAbCdEfGhIj"));
    expect((await enrollmentOf(f.campaign, rec)).profile_url).toBe("https://www.linkedin.com/talent/hire/42/profile/ACwAAAzzzzzzzzz");
    expect((await enrollmentOf(f.campaign, bare)).profile_url).toBe("ACwAAAmemberOnly1");
    expect((await enrollmentOf(f.campaign, classic)).profile_url).toBe("https://www.linkedin.com/in/classic-one");
    for (const id of junk) expect(await enrollmentOf(f.campaign, id)).toBeUndefined();

    const second = await campaignStore.enroll(f.org, f.campaign, { limit: 100 });
    expect(second).toMatchObject({ added: 0, alreadyEnrolled: 4, skippedNoProfile: 4 });

    // The personIds form (search sink) uses the same rule.
    const [other] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'linkedin', 'c2', 'active', ${sql.json(STEPS as never)}) returning id`;
    expect(await enrollPeople(f.org, other.id, [sn, rec, bare, classic, ...junk])).toBe(4);
    expect((await enrollmentOf(other.id, sn)).profile_url).toBe(SN("ACwAAAbCdEfGhIj"));
    expect((await enrollmentOf(other.id, bare)).profile_url).toBe("ACwAAAmemberOnly1");
  });

  it("resolves a Sales Navigator lead through one classic lookup by member id, then writes the slug and a canonical URL back", async () => {
    const f = await fixture();
    const sn = await person(f.org, { url: SN("ACwAAAbCdEfGhIj"), email: "sn@x.test" });
    await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    const gateway = new FakeLinkedInGateway();
    gateway.autoProfiles = false;
    gateway.profiles.set("sam-lee", { member: "ACwAAAbCdEfGhIj", publicSlug: "sam-lee", firstName: "Sam", lastName: "Lee", headline: "CTO", location: null, pictureUrl: null, networkDistance: "third", isPremium: false });
    // A classic-only account refuses linkedin_api with an out-of-scope error. The first call carries none, so it never sees it.
    gateway.profileFailure = ({ linkedinApi }) => (linkedinApi ? "insufficient_privileges" : null);

    expect((await resolveNext(gateway, f)).kind).toBe("resolved");
    expect(gateway.profileCalls).toEqual([{ account: expect.any(String), identifier: "ACwAAAbCdEfGhIj", linkedinApi: null }]);
    expect((await sql`select status from linkedin_accounts where id = ${f.account}`)[0].status).toBe("connected");

    const row = await personRow(sn);
    expect(row).toMatchObject({ linkedin_slug: "sam-lee", linkedin_url: "https://www.linkedin.com/in/sam-lee/", first_name: "Sam", raw: { linkedin_member_id: "ACwAAAbCdEfGhIj" } });
    expect(await enrollmentOf(f.campaign, sn)).toMatchObject({ provider_id: "ACwAAAbCdEfGhIj", profile_url: "https://www.linkedin.com/in/sam-lee", status: "pending" });
  });

  it("looks a recruiter id and a bare provider id up without linkedin_api", async () => {
    const f = await fixture();
    const rec = await person(f.org, { url: "https://www.linkedin.com/talent/profile/ACwAAArecruiter1" });
    await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    const hidden = (member: string) => ({ member, publicSlug: null, firstName: null, lastName: null, headline: null, location: null, pictureUrl: null, networkDistance: "third" as const, isPremium: false });
    const gateway = new FakeLinkedInGateway();
    gateway.profiles.set("rec", hidden("ACwAAArecruiter1"));
    await resolveNext(gateway, f);
    expect(gateway.profileCalls).toEqual([expect.objectContaining({ identifier: "ACwAAArecruiter1", linkedinApi: null })]);
    expect((await personRow(rec)).linkedin_url).toBe("https://www.linkedin.com/talent/profile/ACwAAArecruiter1");

    const g = await fixture();
    const bare = await person(g.org, { member: "ACwAAAmemberOnly1" });
    await campaignStore.enroll(g.org, g.campaign, { limit: 10 });
    const bareGateway = new FakeLinkedInGateway();
    bareGateway.profiles.set("bare", hidden("ACwAAAmemberOnly1"));
    await resolveNext(bareGateway, g);
    expect(bareGateway.profileCalls).toEqual([expect.objectContaining({ identifier: "ACwAAAmemberOnly1", linkedinApi: null })]);
    expect((await personRow(bare)).linkedin_slug).toBeNull();
  });

  it("never overwrites a classic URL when it writes the slug back", async () => {
    const f = await fixture();
    const p = await person(f.org, { url: "https://www.linkedin.com/in/typed-by-hand/", member: "ACwAAAmemberOnly1" });
    await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    const gateway = new FakeLinkedInGateway();
    gateway.autoProfiles = false;
    gateway.profiles.set("resolved-slug", { member: "ACwAAAmemberOnly1", publicSlug: "resolved-slug", firstName: null, lastName: null, headline: null, location: null, pictureUrl: null, networkDistance: "third", isPremium: false });
    expect((await resolveNext(gateway, f)).kind).toBe("resolved");
    expect(await personRow(p)).toMatchObject({ linkedin_slug: "resolved-slug", linkedin_url: "https://www.linkedin.com/in/typed-by-hand/" });
  });

  it("fails the enrollment on a slug collision and leaves both leads as they were", async () => {
    const f = await fixture();
    const owner = await person(f.org, { slug: "sam-lee", url: "https://www.linkedin.com/in/sam-lee/" });
    const sn = await person(f.org, { url: SN("ACwAAAbCdEfGhIj"), email: "sn@x.test" });
    await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    // Only the Sales Navigator lead stays enrolled, so the engine resolves it.
    await sql`delete from campaign_enrollments where campaign_id = ${f.campaign} and person_id = ${owner}`;
    const gateway = new FakeLinkedInGateway();
    gateway.autoProfiles = false;
    gateway.profiles.set("sam-lee", { member: "ACwAAAbCdEfGhIj", publicSlug: "sam-lee", firstName: "Sam", lastName: "Lee", headline: null, location: null, pictureUrl: null, networkDistance: "third", isPremium: false });

    expect((await resolveNext(gateway, f)).kind).toBe("resolve_failed");

    const enrollment = await enrollmentOf(f.campaign, sn);
    expect(enrollment).toMatchObject({ status: "failed", provider_id: null, resolve_last_error: COLLISION });
    expect(enrollment.stop_reason).toContain(COLLISION);
    expect(await personRow(sn)).toMatchObject({ linkedin_slug: null, linkedin_url: SN("ACwAAAbCdEfGhIj"), first_name: null });
    expect(await personRow(owner)).toMatchObject({ linkedin_slug: "sam-lee", linkedin_url: "https://www.linkedin.com/in/sam-lee/" });
    // The connection stays usable after the savepoint rolled back.
    expect((await sql`select count(*)::int as n from people where organization_id = ${f.org}`)[0].n).toBe(2);
  });

  it("lowercases a slug returned by the provider, so a mixed-case slug collides with the lead that holds it", async () => {
    const f = await fixture();
    const owner = await person(f.org, { slug: "jane-doe", url: "https://www.linkedin.com/in/jane-doe/" });
    const sn = await person(f.org, { url: SN("ACwAAAbCdEfGhIj"), email: "sn@x.test" });
    await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    await sql`delete from campaign_enrollments where campaign_id = ${f.campaign} and person_id = ${owner}`;
    const gateway = new FakeLinkedInGateway();
    gateway.autoProfiles = false;
    gateway.profiles.set("jane", { member: "ACwAAAbCdEfGhIj", publicSlug: "Jane-Doe", firstName: "Jane", lastName: "Doe", headline: null, location: null, pictureUrl: null, networkDistance: "third", isPremium: false });

    expect((await resolveNext(gateway, f)).kind).toBe("resolve_failed");

    expect(await enrollmentOf(f.campaign, sn)).toMatchObject({ status: "failed", resolve_last_error: COLLISION });
    expect(await personRow(sn)).toMatchObject({ linkedin_slug: null, first_name: null });
    expect((await sql`select count(*)::int as n from people where organization_id = ${f.org} and linkedin_slug = 'jane-doe'`)[0].n).toBe(1);
  });

  it("writes the slug back in lowercase", async () => {
    const f = await fixture();
    const sn = await person(f.org, { url: SN("ACwAAAbCdEfGhIj"), email: "sn@x.test" });
    await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    const gateway = new FakeLinkedInGateway();
    gateway.autoProfiles = false;
    gateway.profiles.set("x", { member: "ACwAAAbCdEfGhIj", publicSlug: "Sam-LEE", firstName: null, lastName: null, headline: null, location: null, pictureUrl: null, networkDistance: "third", isPremium: false });
    expect((await resolveNext(gateway, f)).kind).toBe("resolved");
    expect(await personRow(sn)).toMatchObject({ linkedin_slug: "sam-lee", linkedin_url: "https://www.linkedin.com/in/sam-lee/" });
    expect(await enrollmentOf(f.campaign, sn)).toMatchObject({ profile_url: "https://www.linkedin.com/in/sam-lee" });
  });

  it("enrolls a Sales Navigator or Recruiter lead whose URL separates the id with an encoded comma", async () => {
    const f = await fixture();
    const id = "ACwAAAbCdEfGhIj";
    const snUrl = `https://www.linkedin.com/sales/lead/${id}%2CNAME_SEARCH%2Cxyz`;
    const recUrl = `https://www.linkedin.com/talent/profile/${id}%2cSEARCH`;
    const sn = await person(f.org, { url: snUrl, email: "a@x.test" });
    const rec = await person(f.org, { url: recUrl, email: "b@x.test" });
    const short = await person(f.org, { url: "https://www.linkedin.com/sales/lead/ACwAAA%2CNAME", email: "c@x.test" });
    const result = await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    expect(result).toMatchObject({ added: 2, skippedNoProfile: 1 });
    expect(await enrollmentOf(f.campaign, sn)).toMatchObject({ profile_url: snUrl, provider_id: null, status: "pending" });
    expect(await enrollmentOf(f.campaign, rec)).toMatchObject({ profile_url: recUrl, provider_id: null, status: "pending" });
    expect(await enrollmentOf(f.campaign, short)).toBeUndefined();
    const gateway = new FakeLinkedInGateway();
    await resolveNext(gateway, f);
    expect(gateway.profileCalls[0]).toMatchObject({ identifier: id });
  });

  const memberProfile = { member: "ACwAAAbCdEfGhIj", publicSlug: "sam-lee", firstName: "Sam", lastName: "Lee", headline: null, location: null, pictureUrl: null, networkDistance: "third" as const, isPremium: false };
  const NO_ACCESS = "This LinkedIn account has no Sales Navigator or Recruiter access, and the member could not be found with a standard lookup.";

  type Api = "sales_navigator" | "recruiter" | null;
  /** The recorded lookups of one identifier, in call order. */
  const callsFor = (gateway: FakeLinkedInGateway, identifier: string) => gateway.profileCalls.filter((c) => c.identifier === identifier).map((c) => c.linkedinApi);
  const accountStatus = async (id: string) => (await sql`select status from linkedin_accounts where id = ${id}`)[0].status;
  const detailsOf = async (campaign: string, personId: string) =>
    (await sql`select d.resolve_retry_count, d.resolve_next_attempt_at, d.resolve_last_error from linkedin_enrollment_details d join campaign_enrollments e on e.id = d.enrollment_id where e.campaign_id = ${campaign} and e.person_id = ${personId}`)[0];
  const snLead = async (f: { org: string; campaign: string }, id = "ACwAAAbCdEfGhIj") => {
    const lead = await person(f.org, { url: SN(id), email: `${id}@x.test` });
    await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    return lead;
  };
  /** A fake whose classic call (no linkedin_api) answers `classic` and whose retry answers `retry` (null: the lookup runs). */
  const scripted = (classic: ReturnType<FakeLinkedInGateway["profileFailure"]>, retry: ReturnType<FakeLinkedInGateway["profileFailure"]>) => {
    const gateway = new FakeLinkedInGateway();
    gateway.autoProfiles = false;
    gateway.profiles.set("sam-lee", memberProfile);
    gateway.profileFailure = ({ linkedinApi }) => (linkedinApi ? retry : classic);
    return gateway;
  };

  it("retries once with linkedin_api after a classic not_found and resolves on a Sales Navigator capable account", async () => {
    const f = await fixture();
    const sn = await snLead(f);
    const gateway = scripted("not_found", null);

    expect((await resolveNext(gateway, f)).kind).toBe("resolved");
    expect(callsFor(gateway, "ACwAAAbCdEfGhIj")).toEqual<Api[]>([null, "sales_navigator"]);
    expect(await enrollmentOf(f.campaign, sn)).toMatchObject({ provider_id: "ACwAAAbCdEfGhIj", status: "pending" });
  });

  it.each(["rejected", "invalid_recipient", "insufficient_privileges"] as const)("retries once with linkedin_api after a classic %s and resolves", async (classic) => {
    const f = await fixture();
    await snLead(f);
    const gateway = scripted(classic, null);
    expect((await resolveNext(gateway, f)).kind).toBe("resolved");
    expect(callsFor(gateway, "ACwAAAbCdEfGhIj")).toEqual<Api[]>([null, "sales_navigator"]);

    const g = await fixture();
    const rec = await person(g.org, { url: "https://www.linkedin.com/talent/profile/ACwAAArecruiter1", email: "r@x.test" });
    await campaignStore.enroll(g.org, g.campaign, { limit: 10 });
    const recGateway = scripted(classic, null);
    recGateway.profiles.set("rec", { ...memberProfile, member: "ACwAAArecruiter1", publicSlug: "rec-one" });
    expect((await resolveNext(recGateway, g)).kind).toBe("resolved");
    expect(callsFor(recGateway, "ACwAAArecruiter1")).toEqual<Api[]>([null, "recruiter"]);
    expect(await enrollmentOf(g.campaign, rec)).toMatchObject({ provider_id: "ACwAAArecruiter1", status: "pending" });
  });

  it("fails non-fatally, keeps the account connected, retries with backoff and exhausts after the limit when the retry is out of scope", async () => {
    const f = await fixture();
    const sn = await snLead(f);
    const gateway = scripted("not_found", "insufficient_privileges");

    expect((await resolveNext(gateway, f)).kind).toBe("resolve_failed");
    expect(await enrollmentOf(f.campaign, sn)).toMatchObject({ status: "pending", resolve_last_error: NO_ACCESS });
    const first = await detailsOf(f.campaign, sn);
    expect(first.resolve_retry_count).toBe(1);
    expect(first.resolve_next_attempt_at).not.toBeNull();
    expect(await accountStatus(f.account)).toBe("connected");

    // Not due yet: the backoff keeps the lead out of the claim.
    current = new Date(first.resolve_next_attempt_at.getTime() - 60_000);
    expect((await engine.runNextLinkedInAction(deps(gateway), f.account)).kind).toBe("idle");
    expect(gateway.profileCalls).toHaveLength(2);

    current = new Date(first.resolve_next_attempt_at.getTime() + 60_000);
    expect((await engine.runNextLinkedInAction(deps(gateway), f.account)).kind).toBe("resolve_failed");
    const second = await detailsOf(f.campaign, sn);
    expect(second.resolve_retry_count).toBe(2);
    expect(await enrollmentOf(f.campaign, sn)).toMatchObject({ status: "pending" });

    current = new Date(second.resolve_next_attempt_at.getTime() + 60_000);
    expect((await engine.runNextLinkedInAction(deps(gateway), f.account)).kind).toBe("resolve_failed");
    expect(await detailsOf(f.campaign, sn)).toMatchObject({ resolve_retry_count: 3, resolve_next_attempt_at: null });
    expect(await enrollmentOf(f.campaign, sn)).toMatchObject({ status: "failed", resolve_last_error: NO_ACCESS });
    expect(callsFor(gateway, "ACwAAAbCdEfGhIj")).toEqual<Api[]>([null, "sales_navigator", null, "sales_navigator", null, "sales_navigator"]);
    expect(await accountStatus(f.account)).toBe("connected");
    expect((await resolveNext(gateway, f)).kind).toBe("idle");
  });

  it("fails the Recruiter lead the same way and names the Recruiter api on its retry", async () => {
    const f = await fixture();
    const rec = await person(f.org, { url: "https://www.linkedin.com/talent/profile/ACwAAArecruiter1", email: "r@x.test" });
    await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    const gateway = scripted("not_found", "insufficient_privileges");
    expect((await resolveNext(gateway, f)).kind).toBe("resolve_failed");
    expect(callsFor(gateway, "ACwAAArecruiter1")).toEqual<Api[]>([null, "recruiter"]);
    expect(await enrollmentOf(f.campaign, rec)).toMatchObject({ resolve_last_error: NO_ACCESS });
  });

  it("disconnects the account when the retry answers auth, a real credential failure", async () => {
    const f = await fixture();
    const sn = await snLead(f);
    const gateway = scripted("not_found", "auth");

    expect((await resolveNext(gateway, f)).kind).toBe("paused");
    expect(callsFor(gateway, "ACwAAAbCdEfGhIj")).toEqual<Api[]>([null, "sales_navigator"]);
    expect(await accountStatus(f.account)).toBe("disconnected");
    expect((await detailsOf(f.campaign, sn)).resolve_retry_count).toBe(0);
  });

  it("retries later when the retry has an unknown outcome, and does not retry after an unknown first outcome", async () => {
    const f = await fixture();
    const sn = await snLead(f);
    const gateway = scripted("not_found", "transient");
    expect((await resolveNext(gateway, f)).kind).toBe("resolve_failed");
    expect(await enrollmentOf(f.campaign, sn)).toMatchObject({ status: "pending" });
    expect(await detailsOf(f.campaign, sn)).toMatchObject({ resolve_retry_count: 1 });
    expect(await accountStatus(f.account)).toBe("connected");

    const g = await fixture();
    await snLead(g);
    const outage = scripted("transient", null);
    expect((await resolveNext(outage, g)).kind).toBe("resolve_failed");
    expect(callsFor(outage, "ACwAAAbCdEfGhIj")).toEqual<Api[]>([null]);
  });

  it("fails as the first call would when the retry answers not_found (fatal) or rejected (retryable)", async () => {
    const f = await fixture();
    const sn = await snLead(f);
    expect((await resolveNext(scripted("not_found", "not_found"), f)).kind).toBe("resolve_failed");
    expect(await enrollmentOf(f.campaign, sn)).toMatchObject({ status: "failed" });

    const g = await fixture();
    const other = await snLead(g);
    expect((await resolveNext(scripted("not_found", "rejected"), g)).kind).toBe("resolve_failed");
    expect(await enrollmentOf(g.campaign, other)).toMatchObject({ status: "pending" });
  });

  it("still disconnects the account when the first, classic lookup answers auth", async () => {
    const f = await fixture();
    await person(f.org, { url: SN("ACwAAAbCdEfGhIj"), email: "sn@x.test" });
    await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    const gateway = new FakeLinkedInGateway();
    gateway.profileFailure = () => "auth";

    expect((await resolveNext(gateway, f)).kind).toBe("paused");
    expect(gateway.profileCalls).toHaveLength(1);
    expect((await sql`select status from linkedin_accounts where id = ${f.account}`)[0].status).toBe("disconnected");
  });

  it.each(["not_found", "rejected", "insufficient_privileges", "auth"] as const)("does not retry a classic lead after %s", async (failure) => {
    const f = await fixture();
    await person(f.org, { slug: "classic-one", url: "https://www.linkedin.com/in/classic-one/", email: "c@x.test" });
    await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    const gateway = new FakeLinkedInGateway();
    gateway.profileFailure = () => failure;
    await resolveNext(gateway, f);
    expect(callsFor(gateway, "classic-one")).toEqual<Api[]>([null]);
  });

  it("leaves a classic lead exactly as before: no linkedin_api, nothing written back", async () => {
    const f = await fixture();
    const p = await person(f.org, { slug: "classic-one", url: "https://www.linkedin.com/in/classic-one/", email: "c@x.test" });
    await campaignStore.enroll(f.org, f.campaign, { limit: 10 });
    const before = await personRow(p);
    const gateway = new FakeLinkedInGateway();
    expect((await resolveNext(gateway, f)).kind).toBe("resolved");
    expect(gateway.profileCalls).toEqual([expect.objectContaining({ identifier: "classic-one", linkedinApi: null })]);
    const after = await personRow(p);
    expect({ slug: after.linkedin_slug, url: after.linkedin_url, raw: after.raw }).toEqual({ slug: before.linkedin_slug, url: before.linkedin_url, raw: null });
  });

  it("creates one lead when the same member id arrives by file import, again by file, and by search result", async () => {
    const f = await fixture();
    const id = "ACwAAAbCdEfGhIjKlMnOpQrStUv";
    const mapping = { LinkedIn: "linkedin", First: "first_name" } as const;
    const command = (rows: Array<Record<string, string>>) => ({ organizationId: f.org, userId: user, filename: "a.csv", headers: ["LinkedIn", "First"], rows, mapping: { ...mapping } });

    const first = await importLeads({ store: leadStore }, command([{ LinkedIn: SN(id), First: "Sam" }]));
    expect(first.stats).toMatchObject({ created: 1, invalid: 0 });
    const again = await importLeads({ store: leadStore }, command([{ LinkedIn: id, First: "Sam" }]));
    expect(again.stats.created).toBe(0);

    const found = await importFoundPeople(
      { store: foundStore },
      { organizationId: f.org, source: "linkedin_search:x", people: [{ key: "k", profile: "", memberId: id, url: `https://www.linkedin.com/in/${id}`, name: "Sam Lee", headline: "CTO" }] },
    );
    expect(found.people.get("k")).toMatchObject({ created: false });
    const rows = await sql`select linkedin_url, raw, title from people where organization_id = ${f.org}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ linkedin_url: SN(id), raw: { linkedin_member_id: id }, title: "CTO" });
  });

  it("creates a lead from a search result with only a member id, and none from a result with neither", async () => {
    const f = await fixture();
    const report = await importFoundPeople(
      { store: foundStore },
      {
        organizationId: f.org,
        source: "linkedin_search:y",
        people: [
          { key: "a", profile: "", memberId: "ACwAAAsearch12345", url: null, name: "Ann", headline: null },
          { key: "b", profile: "https://www.linkedin.com/company/acme", name: "Acme", headline: null },
        ],
      },
    );
    expect(report.people.get("a")).toMatchObject({ created: true });
    expect(report.skipped).toEqual(["b"]);
    expect((await sql`select raw from people where organization_id = ${f.org}`).map((r) => r.raw)).toEqual([{ linkedin_member_id: "ACwAAAsearch12345" }]);
  });
});
