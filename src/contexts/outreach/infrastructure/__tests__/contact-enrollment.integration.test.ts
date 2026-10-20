import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, TEST_DATABASE_URL, testSql, useTestEnv, waitForLockWaiters } from "@/test-support/db";

/**
 * Contacts cannot be enrolled ("Leads and CRM" in docs/decisions.md): every candidate select skips a contact, the
 * savepoint path absorbs a conversion that commits after the candidate read, `stopPersonEnrollmentsTx` and the read helpers of
 * the conversion, and the send engine against a conversion-like transaction. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const EMAIL_STEPS = [
  { stepNumber: 1, kind: "email", subject: "Hi", body: "Hello", waitDays: 0 },
  { stepNumber: 2, kind: "email", subject: "Again", body: "Following up", waitDays: 2 },
];
const LINKEDIN_STEPS = [
  { stepNumber: 1, kind: "invitation", body: "Hi", waitDays: 0 },
  { stepNumber: 2, kind: "message", body: "Thanks", waitDays: 1 },
];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb("contacts and campaign enrollment", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let stores: typeof import("../drizzle-management-stores");
  let linkedinStore: typeof import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store");
  let admin: typeof import("../drizzle-enrollment-admin").drizzleEnrollmentAdminStore;
  let guard: typeof import("../contact-guard");
  let conversion: typeof import("../drizzle-conversion-outreach");
  let outreachStore: typeof import("../drizzle-outreach-store").drizzleOutreachStore;
  let linkedinEngineStore: typeof import("../../linkedin/infrastructure/drizzle-linkedin-store");
  let inboundStore: ReturnType<typeof import("../../linkedin/infrastructure/drizzle-linkedin-inbound-store").createDrizzleLinkedInInboundStore>;
  let appDb: typeof import("@/platform/db/client").db;
  let schema: typeof import("@/platform/db/schema");
  const orgs: Array<{ organizationId: string; userId: string }> = [];
  const NOW = new Date("2026-10-14T10:00:00Z");

  async function fixture() {
    const tag = Math.random().toString(36).slice(2, 8);
    const created = await createTestOrg(sql, "K");
    orgs.push(created);
    const { organizationId: org, userId } = created;
    const campaign = async (channel: "email" | "linkedin", over: { type?: string; createdBy?: string | null; status?: string } = {}) =>
      (
        await sql`
          insert into campaigns (organization_id, channel, name, type, status, steps, created_by)
          values (${org}, ${channel}, ${`${channel}-${over.type ?? "regular"}`}, ${over.type ?? "regular"}, ${over.status ?? "active"}, ${sql.json((channel === "email" ? EMAIL_STEPS : LINKEDIN_STEPS) as never)}, ${over.createdBy === undefined ? userId : over.createdBy})
          returning id`
      )[0].id as string;
    // `name` is a word of the search text, so a query for this fixture's tag matches every person of it.
    const person = async (name: string, over: { contact?: boolean; email?: string | null; slug?: string | null } = {}) =>
      (
        await sql`
          insert into people (organization_id, first_name, full_name, email, linkedin_slug, lifecycle, converted_at)
          values (${org}, ${name}, ${`${name} ${tag}`}, ${over.email === undefined ? `${name}-${tag}@acme.test` : over.email}, ${over.slug === undefined ? `${name}-${tag}` : over.slug},
                  ${over.contact ? "contact" : "lead"}, ${over.contact ? new Date().toISOString() : null})
          returning id`
      )[0].id as string;
    const enrollment = async (campaignId: string, personId: string, channel: "email" | "linkedin", status = "pending", extra: { stopReason?: string | null } = {}) => {
      const [{ id }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, stop_reason, next_send_at)
        values (${org}, ${campaignId}, ${personId}, ${channel}, ${status}, ${extra.stopReason ?? null}, ${status === "active" ? NOW.toISOString() : null}) returning id`;
      if (channel === "linkedin") await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, profile_url, resolve_next_attempt_at) values (${id}, ${org}, 'https://www.linkedin.com/in/x', ${NOW.toISOString()})`;
      return id as string;
    };
    return { org, tag, userId, campaign, person, enrollment };
  }
  type F = Awaited<ReturnType<typeof fixture>>;

  const enrolled = async (campaignId: string) => (await sql`select person_id from campaign_enrollments where campaign_id = ${campaignId} order by person_id`).map((r) => r.person_id as string);
  const rowOf = async (id: string) => (await sql`select status, stop_reason, next_send_at from campaign_enrollments where id = ${id}`)[0];

  /**
   * Holds a conversion of `personId` uncommitted on its own connection. `commitWhenBlocked` waits until an enrollment insert queues
   * behind it (the candidate read is long done by then), commits, and returns. It throws when no insert queues, and commits either way.
   */
  async function holdConversion(personId: string) {
    const writer = postgres(TEST_DATABASE_URL ?? "", { max: 1, onnotice: () => undefined });
    await writer`begin`;
    await writer`update people set lifecycle = 'contact', converted_at = now() where id = ${personId}`;
    return {
      async commitWhenBlocked() {
        try {
          await waitForLockWaiters(sql, 1);
        } finally {
          await writer`commit`;
          await writer.end();
        }
      },
    };
  }

  async function raceConversion<T>(personId: string, run: () => Promise<T>): Promise<{ result: T; retries: number }> {
    const before = guard.contactGuardStats.retries;
    const hold = await holdConversion(personId);
    const pending = run();
    // Never leave the writer holding its lock if `run` throws early.
    const settled = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const blocked = await hold.commitWhenBlocked().then(
      () => undefined,
      (error: unknown) => error,
    );
    const outcome = await settled;
    if ("error" in outcome) throw outcome.error;
    if (blocked) throw blocked;
    return { result: outcome.value, retries: guard.contactGuardStats.retries - before };
  }

  beforeAll(async () => {
    stores = await import("../drizzle-management-stores");
    linkedinStore = await import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store");
    ({ drizzleEnrollmentAdminStore: admin } = await import("../drizzle-enrollment-admin"));
    guard = await import("../contact-guard");
    conversion = await import("../drizzle-conversion-outreach");
    ({ drizzleOutreachStore: outreachStore } = await import("../drizzle-outreach-store"));
    linkedinEngineStore = await import("../../linkedin/infrastructure/drizzle-linkedin-store");
    inboundStore = (await import("../../linkedin/infrastructure/drizzle-linkedin-inbound-store")).createDrizzleLinkedInInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
    ({ db: appDb } = await import("@/platform/db/client"));
    schema = await import("@/platform/db/schema");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("every enroll path skips a contact and still enrolls a lead", () => {
    it("email enroll by search counts the contact, enrolls the leads, and a dry run excludes it", async () => {
      const f = await fixture();
      const c = await f.campaign("email");
      const [a, b] = [await f.person("ada"), await f.person("bob")];
      await f.person("cora", { contact: true });
      const retries = guard.contactGuardStats.retries;

      const dry = await stores.drizzleCampaignStore.enroll(f.org, c, { query: f.tag, limit: 100, dryRun: true });
      expect(dry).toMatchObject({ requested: 3, wouldAdd: 2, added: 0, skippedContact: 1 });
      expect(await enrolled(c)).toEqual([]);

      const result = await stores.drizzleCampaignStore.enroll(f.org, c, { query: f.tag, limit: 100 });
      expect(result).toMatchObject({ requested: 3, added: 2, skippedContact: 1, skippedDuplicate: 0, skippedDoNotContact: 0, skippedSuppressed: 0 });
      expect(await enrolled(c)).toEqual([a, b].sort());
      expect(guard.contactGuardStats.retries, "the candidate select did the work, not the trigger").toBe(retries);
    });

    it("LinkedIn enroll by query counts the contact, enrolls the leads, and a dry run excludes it", async () => {
      const f = await fixture();
      const c = await f.campaign("linkedin");
      const [a, b] = [await f.person("ada"), await f.person("bob")];
      await f.person("cora", { contact: true });
      const retries = guard.contactGuardStats.retries;

      const dry = await linkedinStore.drizzleLinkedInCampaignStore.enroll(f.org, c, { query: f.tag, limit: 100, dryRun: true });
      expect(dry).toMatchObject({ requested: 3, wouldAdd: 2, added: 0, skippedContact: 1 });

      const result = await linkedinStore.drizzleLinkedInCampaignStore.enroll(f.org, c, { query: f.tag, limit: 100, collectIds: true });
      expect(result).toMatchObject({ requested: 3, added: 2, skippedContact: 1, skippedDoNotContact: 0, skippedNoProfile: 0 });
      expect([...(result.addedPersonIds ?? [])].sort()).toEqual([a, b].sort());
      expect(await enrolled(c)).toEqual([a, b].sort());
      expect(guard.contactGuardStats.retries).toBe(retries);
    });

    it.each(["email", "linkedin"] as const)("%s picked enroll buckets a contact after missing identity, duplicate, suppressed and do not contact", async (channel) => {
      const f = await fixture();
      const c = await f.campaign(channel);
      const lead = await f.person("lead");
      const plain = await f.person("plain", { contact: true });
      const noIdentity = await f.person("noid", { contact: true, email: null, slug: null });
      const duplicate = await f.person("dupe", { contact: true });
      const suppressed = await f.person("supp", { contact: true, email: `supp-${f.tag}@gone.test` });
      const dnc = await f.person("dnc", { contact: true });
      await f.enrollment(c, duplicate, channel, "cancelled", { stopReason: "converted" });
      await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, ${`supp-${f.tag}@gone.test`}, 'unsubscribed')`;
      await sql`insert into contact_policies (organization_id, person_id, do_not_contact, source, set_at) values (${f.org}, ${dnc}, true, 'human', now())`;
      const retries = guard.contactGuardStats.retries;

      const out = await admin.enrollPicked(f.org, c, channel, [lead, plain, noIdentity, duplicate, suppressed, dnc]);
      expect(out).toEqual({
        requested: 6,
        added: 1,
        skippedMissingIdentity: 1,
        skippedDuplicate: 1,
        skippedRemoved: 0,
        skippedSuppressed: channel === "email" ? 1 : 0,
        // LinkedIn has no suppression list, so the suppressed contact falls through to the contact bucket there.
        skippedDoNotContact: 1,
        skippedContact: channel === "email" ? 1 : 2,
        skippedNotFound: 0,
      });
      expect((await enrolled(c)).sort()).toEqual([lead, duplicate].sort());
      expect(guard.contactGuardStats.retries).toBe(retries);
    });

    it("email query counts put a contact last: missing email, duplicate, suppressed and do not contact win", async () => {
      const f = await fixture();
      const c = await f.campaign("email");
      await f.person("lead");
      await f.person("plain", { contact: true });
      await f.person("noid", { contact: true, email: null });
      const duplicate = await f.person("dupe", { contact: true });
      await f.person("supp", { contact: true, email: `supp-${f.tag}@gone.test` });
      const dnc = await f.person("dnc", { contact: true });
      await f.enrollment(c, duplicate, "email", "cancelled", { stopReason: "converted" });
      await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, ${`supp-${f.tag}@gone.test`}, 'unsubscribed')`;
      await sql`insert into contact_policies (organization_id, person_id, do_not_contact, source, set_at) values (${f.org}, ${dnc}, true, 'human', now())`;

      const dry = await stores.drizzleCampaignStore.enroll(f.org, c, { query: f.tag, limit: 100, dryRun: true });
      expect(dry).toMatchObject({ requested: 6, wouldAdd: 1, skippedNoEmail: 1, skippedDuplicate: 1, skippedSuppressed: 1, skippedDoNotContact: 1, skippedContact: 1 });
    });

    it("enrollEmailPeople and enrollPeople enroll the leads and report the contact", async () => {
      const f = await fixture();
      const [mail, li] = [await f.campaign("email"), await f.campaign("linkedin")];
      const [a, b] = [await f.person("ada"), await f.person("bob")];
      const c = await f.person("cora", { contact: true });
      const retries = guard.contactGuardStats.retries;

      expect(await stores.enrollEmailPeopleCounted(f.org, mail, [a, b, c, a])).toEqual({ added: 2, skippedContact: 1 });
      expect(await linkedinStore.enrollPeopleCounted(f.org, li, [a, b, c])).toEqual({ added: 2, skippedContact: 1 });
      expect(await stores.enrollEmailPeople(f.org, mail, [a, b, c])).toBe(0);
      expect(await enrolled(mail)).toEqual([a, b].sort());
      expect(await enrolled(li)).toEqual([a, b].sort());
      expect(guard.contactGuardStats.retries).toBe(retries);
    });
  });

  describe("a conversion that commits after the candidate read does not fail the batch", () => {
    it("email enroll by search", async () => {
      const f = await fixture();
      const c = await f.campaign("email");
      const [a, b, racer] = [await f.person("ada"), await f.person("bob"), await f.person("race")];
      const { result, retries } = await raceConversion(racer, () => stores.drizzleCampaignStore.enroll(f.org, c, { query: f.tag, limit: 100 }));
      expect(retries).toBeGreaterThan(0);
      expect(result).toMatchObject({ requested: 3, added: 2, skippedContact: 1 });
      expect(result.added + result.skippedContact + result.skippedDuplicate + result.skippedDoNotContact + result.skippedSuppressed + result.skippedNoEmail).toBe(result.requested);
      expect(await enrolled(c)).toEqual([a, b].sort());
    });

    it("LinkedIn enroll by query", async () => {
      const f = await fixture();
      const c = await f.campaign("linkedin");
      const [a, b, racer] = [await f.person("ada"), await f.person("bob"), await f.person("race")];
      const { result, retries } = await raceConversion(racer, () => linkedinStore.drizzleLinkedInCampaignStore.enroll(f.org, c, { query: f.tag, limit: 100 }));
      expect(retries).toBeGreaterThan(0);
      expect(result).toMatchObject({ requested: 3, added: 2, skippedContact: 1 });
      expect(await enrolled(c)).toEqual([a, b].sort());
      const details = await sql`select count(*)::int as n from linkedin_enrollment_details where organization_id = ${f.org}`;
      expect(details[0].n).toBe(2);
    });

    it.each(["email", "linkedin"] as const)("%s picked enroll", async (channel) => {
      const f = await fixture();
      const c = await f.campaign(channel);
      const [a, b, racer] = [await f.person("ada"), await f.person("bob"), await f.person("race")];
      const { result, retries } = await raceConversion(racer, () => admin.enrollPicked(f.org, c, channel, [a, b, racer]));
      expect(retries).toBeGreaterThan(0);
      expect(result).toMatchObject({ requested: 3, added: 2, skippedContact: 1, skippedDuplicate: 0 });
      expect(await enrolled(c)).toEqual([a, b].sort());
      if (channel === "linkedin") expect((await sql`select count(*)::int as n from linkedin_enrollment_details where organization_id = ${f.org}`)[0].n).toBe(2);
    });

    it("enrollEmailPeople", async () => {
      const f = await fixture();
      const c = await f.campaign("email");
      const [a, b, racer] = [await f.person("ada"), await f.person("bob"), await f.person("race")];
      const { result } = await raceConversion(racer, () => appDb.transaction((tx) => stores.enrollEmailPeopleCounted(f.org, c, [a, b, racer], tx)));
      expect(result).toEqual({ added: 2, skippedContact: 1 });
      expect(await enrolled(c)).toEqual([a, b].sort());
    });

    it("enrollPeople (the Grid handoff and the search sink)", async () => {
      const f = await fixture();
      const c = await f.campaign("linkedin");
      const [a, b, racer] = [await f.person("ada"), await f.person("bob"), await f.person("race")];
      const { result, retries } = await raceConversion(racer, () => linkedinStore.enrollPeopleCounted(f.org, c, [a, b, racer]));
      expect(retries).toBeGreaterThan(0);
      expect(result).toEqual({ added: 2, skippedContact: 1 });
      expect(await enrolled(c)).toEqual([a, b].sort());
    });

    it("rolls back only the chunk's insert: rows of earlier statements in the same transaction stay", async () => {
      const f = await fixture();
      const [first, second] = [await f.campaign("email"), await f.campaign("email")];
      const [a, racer] = [await f.person("ada"), await f.person("race")];
      const { result } = await raceConversion(racer, () =>
        appDb.transaction(async (tx) => {
          const one = await stores.enrollEmailPeopleCounted(f.org, first, [a], tx);
          const two = await stores.enrollEmailPeopleCounted(f.org, second, [a, racer], tx);
          return { one, two };
        }),
      );
      expect(result).toEqual({ one: { added: 1, skippedContact: 0 }, two: { added: 1, skippedContact: 1 } });
      expect(await enrolled(first)).toEqual([a]);
      expect(await enrolled(second)).toEqual([a]);
    });
  });

  describe("stopPersonEnrollmentsTx", () => {
    it("cancels only the person's pending and active rows and clears the LinkedIn retry time", async () => {
      const f = await fixture();
      const [mail, li, personal, other] = [await f.campaign("email"), await f.campaign("linkedin"), await f.campaign("linkedin", { type: "personal" }), await f.campaign("email")];
      const p = await f.person("target");
      const bystander = await f.person("bystander");
      const pending = await f.enrollment(mail, p, "email", "pending");
      const active = await f.enrollment(li, p, "linkedin", "active");
      const inPersonal = await f.enrollment(personal, p, "linkedin", "pending");
      const removed = await f.enrollment(other, p, "email", "removed", { stopReason: "removed" });
      const replied = await f.enrollment(await f.campaign("email"), p, "email", "replied", { stopReason: "replied" });
      const completed = await f.enrollment(await f.campaign("email"), p, "email", "completed");
      const others = await f.enrollment(mail, bystander, "email", "pending");
      const otherLinkedIn = await f.enrollment(li, bystander, "linkedin", "pending");
      // Another organization with the same person id shape: a foreign enrollment is never touched.
      const foreign = await fixture();
      const foreignPerson = await foreign.person("target");
      const foreignEnrollment = await foreign.enrollment(await foreign.campaign("email"), foreignPerson, "email", "pending");

      const out = await appDb.transaction((tx) => conversion.stopPersonEnrollmentsTx(tx, { organizationId: f.org, personId: p, reason: "converted", now: NOW }));
      expect(out).toEqual({ stopped: 3 });
      for (const id of [pending, active, inPersonal]) expect(await rowOf(id)).toMatchObject({ status: "cancelled", stop_reason: "converted", next_send_at: null });
      expect(await rowOf(removed)).toMatchObject({ status: "removed", stop_reason: "removed" });
      expect(await rowOf(replied)).toMatchObject({ status: "replied", stop_reason: "replied" });
      expect(await rowOf(completed)).toMatchObject({ status: "completed" });
      expect(await rowOf(others)).toMatchObject({ status: "pending", stop_reason: null });
      expect(await rowOf(foreignEnrollment)).toMatchObject({ status: "pending" });
      const retry = await sql`select enrollment_id, resolve_next_attempt_at from linkedin_enrollment_details where enrollment_id in ${sql([active, inPersonal, otherLinkedIn])}`;
      const byId = new Map(retry.map((r) => [r.enrollment_id as string, r.resolve_next_attempt_at]));
      expect(byId.get(active)).toBeNull();
      expect(byId.get(inPersonal)).toBeNull();
      expect(byId.get(otherLinkedIn), "the other person's retry time stays").not.toBeNull();
      const updated = await sql`select updated_at from campaign_enrollments where id = ${pending}`;
      expect(new Date(updated[0].updated_at).toISOString()).toBe(NOW.toISOString());

      expect(await appDb.transaction((tx) => conversion.stopPersonEnrollmentsTx(tx, { organizationId: f.org, personId: p, reason: "converted", now: NOW }))).toEqual({ stopped: 0 });
    });

    it("the cancelled rows show under Suppressed / stopped with the label Became a contact", async () => {
      const f = await fixture();
      const [mail, li] = [await f.campaign("email"), await f.campaign("linkedin")];
      const p = await f.person("target");
      await f.enrollment(mail, p, "email", "pending");
      await f.enrollment(li, p, "linkedin", "pending");
      await appDb.transaction((tx) => conversion.stopPersonEnrollmentsTx(tx, { organizationId: f.org, personId: p, reason: "converted", now: NOW }));
      const { stopReasonNote } = await import("../../domain/campaign-view");
      const { describeLinkedInProgress } = await import("../../linkedin/domain/linkedin");

      const query = { tab: "stopped" as const, search: "", page: 1, pageSize: 50 };
      const emailRows = await stores.drizzleCampaignStore.listEnrollments(f.org, mail, query);
      expect(emailRows.rows).toHaveLength(1);
      expect(emailRows.rows[0]).toMatchObject({ status: "cancelled", stopReason: "converted" });
      expect(stopReasonNote(emailRows.rows[0].status, emailRows.rows[0].stopReason)).toBe("Became a contact");
      expect(emailRows.counts.stopped).toBe(1);

      const linkedinRows = await linkedinStore.drizzleLinkedInCampaignStore.listEnrollments(f.org, li, query);
      expect(linkedinRows.rows).toHaveLength(1);
      const row = linkedinRows.rows[0];
      expect(describeLinkedInProgress({ status: row.status, connectionState: row.connectionState, currentStep: row.currentStep, totalSteps: 2, stopReason: row.stopReason })).toMatchObject({ label: "Cancelled", detail: "Became a contact" });
    });
  });

  describe("read helpers of the conversion", () => {
    it("liveEnrollmentSummary splits live enrollments by campaign type and lists the personal creators", async () => {
      const f = await fixture();
      const other = await fixture();
      const [regular, regular2, personal, personalOrphan, closed] = [
        await f.campaign("email"),
        await f.campaign("linkedin"),
        await f.campaign("linkedin", { type: "personal" }),
        await f.campaign("linkedin", { type: "personal", createdBy: null }),
        await f.campaign("email"),
      ];
      const [p, q, none] = [await f.person("p"), await f.person("q"), await f.person("none")];
      await f.enrollment(regular, p, "email", "pending");
      await f.enrollment(regular2, p, "linkedin", "active");
      await f.enrollment(personal, p, "linkedin", "pending");
      await f.enrollment(personalOrphan, p, "linkedin", "active");
      await f.enrollment(closed, p, "email", "removed");
      await f.enrollment(personal, q, "linkedin", "replied");
      // A creator who also made the other personal campaign appears once.
      const out = await conversion.liveEnrollmentSummary(f.org, [p, q, none, p]);
      expect(out.get(p)).toEqual({ regular: 2, personal: { count: 2, createdBy: [f.userId] } });
      expect(out.get(q)).toEqual({ regular: 0, personal: { count: 0, createdBy: [] } });
      expect(out.get(none)).toEqual({ regular: 0, personal: { count: 0, createdBy: [] } });
      expect([...out.keys()].sort()).toEqual([p, q, none].sort());
      // Another organization's rows never count.
      expect((await conversion.liveEnrollmentSummary(other.org, [p])).get(p)).toEqual({ regular: 0, personal: { count: 0, createdBy: [] } });
    });

    it("latestRepliedEnrollment picks the newest updated replied enrollment, ties by id", async () => {
      const f = await fixture();
      const [c1, c2, c3] = [await f.campaign("email"), await f.campaign("email"), await f.campaign("email")];
      const [p, q, none] = [await f.person("p"), await f.person("q"), await f.person("none")];
      const oldest = await f.enrollment(c1, p, "email", "replied");
      const newest = await f.enrollment(c2, p, "email", "replied");
      const notReplied = await f.enrollment(c3, p, "email", "pending");
      await sql`update campaign_enrollments set updated_at = ${"2026-10-01T00:00:00Z"} where id = ${oldest}`;
      await sql`update campaign_enrollments set updated_at = ${"2026-10-05T00:00:00Z"} where id = ${newest}`;
      await sql`update campaign_enrollments set updated_at = ${"2026-10-09T00:00:00Z"} where id = ${notReplied}`;
      const tieA = await f.enrollment(c1, q, "email", "replied");
      const tieB = await f.enrollment(c2, q, "email", "replied");
      await sql`update campaign_enrollments set updated_at = ${"2026-10-02T00:00:00Z"} where id in ${sql([tieA, tieB])}`;

      const out = await conversion.latestRepliedEnrollment(f.org, [p, q, none]);
      expect(out.get(p)).toBe(newest);
      expect(out.get(q)).toBe([tieA, tieB].sort().at(-1));
      expect(out.has(none)).toBe(false);
      expect((await conversion.latestRepliedEnrollment((await fixture()).org, [p])).size).toBe(0);
    });

    it("enrollmentSources names the campaign of each enrollment and skips other organizations", async () => {
      const f = await fixture();
      const [regular, personal] = [await f.campaign("email"), await f.campaign("linkedin", { type: "personal" })];
      const p = await f.person("p");
      const a = await f.enrollment(regular, p, "email", "replied");
      const b = await f.enrollment(personal, p, "linkedin", "replied");
      const out = await conversion.enrollmentSources(f.org, [a, b, "00000000-0000-4000-8000-000000000000"]);
      expect(out.get(a)).toEqual({ campaignId: regular, name: "email-regular", type: "regular" });
      expect(out.get(b)).toEqual({ campaignId: personal, name: "linkedin-personal", type: "personal" });
      expect(out.size).toBe(2);
      expect((await conversion.enrollmentSources((await fixture()).org, [a])).size).toBe(0);
    });
  });

  describe("stress: the send engine against conversions with random delays", () => {
    /** A conversion: the people row, then the person's enrollments, in one transaction. */
    const convert = (org: string, personId: string) =>
      appDb.transaction(async (tx) => {
        await tx.update(schema.people).set({ lifecycle: "contact", convertedAt: new Date() }).where(and(eq(schema.people.organizationId, org), eq(schema.people.id, personId)));
        await sleep(Math.random() * 3);
        await conversion.stopPersonEnrollmentsTx(tx, { organizationId: org, personId, reason: "converted", now: new Date() });
      });
    const settleAll = async (runs: Array<Promise<unknown>>) => {
      const results = await Promise.allSettled(runs);
      return results.flatMap((r) => (r.status === "rejected" ? [r.reason as { code?: string; cause?: { code?: string }; message: string }] : []));
    };
    const N = 120;
    /** Four workers over interleaved slices, so sends and conversions of different people overlap. */
    const inSlices = <T,>(items: T[], run: (item: T) => Promise<unknown>) =>
      [0, 1, 2, 3].map(async (lane) => {
        for (const item of items.filter((_, i) => i % 4 === lane)) await run(item);
      });

    it("stress: markSent of an active enrollment (active to active) finishes while its person converts", async () => {
      const f = await fixture();
      const c = await f.campaign("email");
      const [{ id: mailbox }] = await sql`
        insert into mailboxes (organization_id, email_address, display_name, status, daily_send_limit, working_hours)
        values (${f.org}, ${`m-${f.tag}@corp.test`}, 'S', 'connected', 30, ${sql.json({ timeZone: "UTC", days: ALL_DAY })}) returning id`;
      const claims: Array<{ personId: string; claim: unknown }> = [];
      for (let i = 0; i < N; i += 1) {
        const personId = await f.person(`p${i}`);
        const enrollmentId = await f.enrollment(c, personId, "email", "active");
        await sql`update campaign_enrollments set current_step = 1 where id = ${enrollmentId}`;
        const [{ id: sendId }] = await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id) values (${f.org}, ${enrollmentId}, 2, 'email', 'sending', ${mailbox}) returning id`;
        claims.push({ personId, claim: { sendId, enrollmentId, stepNumber: 2, nextStep: { waitDays: 2 }, mailbox: { id: mailbox } } });
      }
      const sendLoop = inSlices(claims, ({ claim }) => outreachStore.markSent(claim as never, { providerMessageId: `pm-${Math.random()}`, threadId: "t" }, new Date()));
      const convertLoop = inSlices([...claims].reverse(), ({ personId }) => convert(f.org, personId));
      const errors = await settleAll([...sendLoop, ...convertLoop]);
      expect(errors).toEqual([]);
      // Whichever side won each enrollment, none is pending or active for a contact.
      const live = await sql`select count(*)::int as n from campaign_enrollments e join people p on p.id = e.person_id where e.organization_id = ${f.org} and p.lifecycle = 'contact' and e.status in ('pending', 'active')`;
      expect(live[0].n).toBe(0);
    }, 60_000);

    async function linkedinFixture(f: F, count: number) {
      const c = await f.campaign("linkedin");
      const [{ id: account }] = await sql`
        insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status, daily_invite_limit, working_hours)
        values (${f.org}, ${`acct-${f.tag}`}, ${`ACo-${f.tag}`}, ${`u-${f.tag}`}, 'connected', 20, ${sql.json({ timeZone: "UTC", days: ALL_DAY })}) returning id`;
      const rows: Array<{ personId: string; enrollmentId: string; member: string }> = [];
      for (let i = 0; i < count; i += 1) {
        const personId = await f.person(`p${i}`);
        const enrollmentId = await f.enrollment(c, personId, "linkedin", "active");
        const member = `ACo-${f.tag}-${i}`;
        await sql`update campaign_enrollments set linkedin_account_id = ${account}, current_step = 1 where id = ${enrollmentId}`;
        await sql`update linkedin_enrollment_details set provider_id = ${member}, connection_state = 'request_sent' where enrollment_id = ${enrollmentId}`;
        rows.push({ personId, enrollmentId, member });
      }
      return { account, rows };
    }

    it("stress: applyAcceptance finishes while its person converts", async () => {
      const f = await fixture();
      const { rows } = await linkedinFixture(f, N);
      const acceptLoop = inSlices(rows, ({ enrollmentId }) => appDb.transaction((tx) => linkedinEngineStore.applyAcceptance(tx, enrollmentId, 1, new Date())));
      const convertLoop = inSlices([...rows].reverse(), ({ personId }) => convert(f.org, personId));
      const errors = await settleAll([...acceptLoop, ...convertLoop]);
      expect(errors).toEqual([]);
    }, 60_000);

    it("stress: the LinkedIn webhook loop finishes while its people convert", async () => {
      const f = await fixture();
      const { rows } = await linkedinFixture(f, N);
      const webhookLoop = inSlices(rows, ({ member }) => inboundStore.apply(f.org, { type: "connection_accepted", account: `acct-${f.tag}`, member, name: null, profileUrl: null }, new Date()));
      const convertLoop = inSlices([...rows].reverse(), ({ personId }) => convert(f.org, personId));
      const errors = await settleAll([...webhookLoop, ...convertLoop]);
      expect(errors).toEqual([]);
      const live = await sql`select count(*)::int as n from campaign_enrollments e join people p on p.id = e.person_id where e.organization_id = ${f.org} and p.lifecycle = 'contact' and e.status in ('pending', 'active')`;
      expect(live[0].n).toBe(0);
    }, 60_000);
  });
});

