import { drizzleEnrollmentAdminStore } from "../drizzle-enrollment-admin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError, type Actor } from "@/shared/errors";
import type { EnrollmentListQuery } from "../../domain/enrollment-list";
import { ENROLLMENT_TABS, statusesForTab } from "../../domain/enrollment-list";
import { createTestOrg, describeDb, dropOrgs, type TestOrg, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

const q = (over: Partial<EnrollmentListQuery> = {}): EnrollmentListQuery => ({ tab: "all", search: "", page: 1, pageSize: 50, ...over });

describeDb("campaign lead tables: tabs, search and paging", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let email: typeof import("../../application/campaign-management");
  let linkedin: typeof import("../../linkedin/application/linkedin-campaigns");
  let emailStore: typeof import("../drizzle-management-stores").drizzleCampaignStore;
  let linkedinStore: typeof import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store").drizzleLinkedInCampaignStore;
  let mailboxStore: typeof import("../drizzle-management-stores").drizzleMailboxStore;
  const orgs: TestOrg[] = [];

  async function org() {
    const created = await createTestOrg(sql, "CL");
    orgs.push(created);
    const { organizationId: id, userId } = created;
    const actor: Actor = { userId, organizationId: id, role: "owner" };
    return { id, actor };
  }

  const campaign = async (orgId: string, channel: "email" | "linkedin") => {
    const [{ id }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${orgId}, ${channel}, 'C', 'active') returning id`;
    return id as string;
  };

  /** Inserts one person and one enrollment per entry. Rows share one created_at, so the id breaks every tie. */
  async function enroll(orgId: string, campaignId: string, channel: "email" | "linkedin", people: Array<{ name: string; status: string; email?: string; title?: string; company?: string; domain?: string }>) {
    const ids: string[] = [];
    for (const [i, p] of people.entries()) {
      let companyId: string | null = null;
      if (p.company) {
        const [row] = await sql`insert into companies (organization_id, domain, name) values (${orgId}, ${p.domain ?? `c${i}-${Math.random()}.test`}, ${p.company}) returning id`;
        companyId = row.id;
      }
      const slug = channel === "linkedin" ? `slug-${Math.random().toString(36).slice(2, 10)}` : null;
      const [person] = await sql`insert into people (organization_id, full_name, first_name, email, title, company_id, linkedin_slug) values (${orgId}, ${p.name}, ${p.name.split(" ")[0]}, ${p.email ?? null}, ${p.title ?? null}, ${companyId}, ${slug}) returning id`;
      const [e] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, created_at) values (${orgId}, ${campaignId}, ${person.id}, ${channel}, ${p.status}, '2026-10-01T10:00:00Z') returning id`;
      ids.push(e.id);
    }
    return ids;
  }

  beforeAll(async () => {
    email = await import("../../application/campaign-management");
    linkedin = await import("../../linkedin/application/linkedin-campaigns");
    ({ drizzleCampaignStore: emailStore, drizzleMailboxStore: mailboxStore } = await import("../drizzle-management-stores"));
    ({ drizzleLinkedInCampaignStore: linkedinStore } = await import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store"));
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  const STATUS_CYCLE = ["pending", "active", "replied", "completed", "bounced", "suppressed", "failed", "cancelled", "removed"];
  // Listing reads only the campaign store, so the sender/enroll admin store stays out of these tests.
  const emailDeps = () => ({ campaigns: emailStore, mailboxes: mailboxStore, admin: drizzleEnrollmentAdminStore }) as unknown as import("../../application/campaign-management").CampaignDeps;
  const detail = (actor: Actor, id: string, query: EnrollmentListQuery) => email.getCampaignDetail(emailDeps(), actor, id, query);

  describe("email", () => {
    let t: Awaited<ReturnType<typeof org>>;
    let other: Awaited<ReturnType<typeof org>>;
    let cid: string;
    let otherCid: string;
    const expected: Record<string, number> = {};

    beforeAll(async () => {
      t = await org();
      other = await org();
      cid = await campaign(t.id, "email");
      otherCid = await campaign(other.id, "email");
      const people = Array.from({ length: 120 }, (_, i) => ({
        name: `Lead ${String(i).padStart(3, "0")}`,
        status: STATUS_CYCLE[i % STATUS_CYCLE.length],
        email: `lead${i}@acme${i % 3}.test`,
        title: i % 10 === 0 ? "VP 50% growth" : "Engineer",
        company: i % 4 === 0 ? "Acme Corp" : "Other Inc",
        domain: i % 4 === 0 ? `acme${i}.io` : undefined,
      }));
      await enroll(t.id, cid, "email", people);
      await enroll(other.id, otherCid, "email", Array.from({ length: 7 }, (_, i) => ({ name: `Other ${i}`, status: "active", email: `o${i}@x.test` })));
      for (const p of people) expected[p.status] = (expected[p.status] ?? 0) + 1;
    });

    it("counts every tab over the whole campaign, whatever filter is active", async () => {
      const wholeCampaign = (await detail(t.actor, cid, q())).enrollments.counts;
      const tabTotal = (tab: (typeof ENROLLMENT_TABS)[number]) =>
        tab === "all" ? 120 - expected.removed : statusesForTab(tab, "active").reduce((n, s) => n + (expected[s] ?? 0), 0);
      for (const tab of ENROLLMENT_TABS) expect(wholeCampaign[tab], tab).toBe(tabTotal(tab));
      for (const tab of ENROLLMENT_TABS) {
        for (const search of ["", "Acme", "no-such-lead"]) {
          const r = (await detail(t.actor, cid, q({ tab, search, pageSize: 20, page: 2 }))).enrollments;
          expect(r.counts, `${tab}/${search}`).toEqual(wholeCampaign);
        }
      }
    });

    it("filters by each tab and the total follows the tab", async () => {
      for (const tab of ENROLLMENT_TABS) {
        const r = (await detail(t.actor, cid, q({ tab, pageSize: 100 }))).enrollments;
        expect(r.total, tab).toBe(r.counts[tab]);
        expect(r.rows).toHaveLength(Math.min(100, r.counts[tab]));
        if (tab !== "all") for (const row of r.rows) expect(statusesForTab(tab, "active")).toContain(row.status);
        if (tab === "all") expect(r.rows.some((row) => row.status === "removed")).toBe(false);
      }
    });

    it("searches email, name, title and company, alone and with a tab", async () => {
      const total = async (over: Partial<EnrollmentListQuery>) => (await detail(t.actor, cid, q({ pageSize: 100, ...over }))).enrollments.total;
      expect(await total({ search: "lead7@" })).toBe(1);
      expect(await total({ search: "LEAD 007" })).toBe(1);
      expect(await total({ search: "acme32.io" })).toBe(1);
      expect(await total({ search: "acme0.test" })).toBeGreaterThan(0);
      const acmeCorp = Array.from({ length: 120 }, (_, i) => i).filter((i) => i % 4 === 0 && STATUS_CYCLE[i % 9] !== "removed").length;
      expect(await total({ search: "Acme Corp" })).toBe(acmeCorp);
      const stoppedAcme = Array.from({ length: 120 }, (_, i) => i).filter((i) => i % 4 === 0 && ["bounced", "suppressed", "failed", "cancelled"].includes(STATUS_CYCLE[i % 9])).length;
      expect(await total({ search: "Acme Corp", tab: "stopped" })).toBe(stoppedAcme);
      expect(await total({ search: "Acme Corp", tab: "removed" })).toBe(Array.from({ length: 120 }, (_, i) => i).filter((i) => i % 4 === 0 && STATUS_CYCLE[i % 9] === "removed").length);
    });

    it("escapes LIKE wildcards in the search", async () => {
      const total = async (search: string) => (await detail(t.actor, cid, q({ search, pageSize: 100, tab: "all" }))).enrollments.total;
      const vp = Array.from({ length: 120 }, (_, i) => i).filter((i) => i % 10 === 0 && STATUS_CYCLE[i % 9] !== "removed").length;
      expect(await total("50%")).toBe(vp);
      expect(await total("%")).toBe(vp);
      expect(await total("_")).toBe(0);
      expect(await total("Lead_00")).toBe(0);
    });

    it("pages 120 rows without gaps or repeats in created desc, id desc order", async () => {
      const all = (await sql`select id from campaign_enrollments where campaign_id = ${cid} and status <> 'removed' order by created_at desc, id desc`).map((r) => r.id as string);
      expect(all).toHaveLength(120 - expected.removed);
      for (const pageSize of [20, 50, 100] as const) {
        const seen: string[] = [];
        for (let page = 1; page <= Math.ceil(all.length / pageSize) + 1; page += 1) {
          const r = (await detail(t.actor, cid, q({ page, pageSize }))).enrollments;
          seen.push(...r.rows.map((row) => row.enrollmentId));
        }
        expect(seen, `size ${pageSize}`).toEqual(all);
      }
    });

    it("counts the people a search would add without enrolling anyone, then adds the same number", async () => {
      const fresh = await campaign(t.id, "email");
      const dry = await emailStore.enroll(t.id, fresh, { limit: 5000, dryRun: true });
      expect(dry).toMatchObject({ added: 0, wouldAdd: 120 });
      const after = await emailStore.listEnrollments(t.id, fresh, q());
      expect(after.counts.all).toBe(0);
      expect(after.sent).toBe(0);
      expect((await emailStore.enroll(t.id, fresh, { limit: 5000 })).added).toBe(120);
      // The limit caps the dry-run count the way it caps the insert.
      expect((await emailStore.enroll(t.id, await campaign(t.id, "email"), { limit: 10, dryRun: true })).wouldAdd).toBe(10);
    });

    it("keeps tenants apart and returns 404 for a campaign of another organization", async () => {
      await expect(detail(other.actor, cid, q())).rejects.toBeInstanceOf(NotFoundError);
      const crossed = await emailStore.listEnrollments(other.id, cid, q());
      expect(crossed.rows).toEqual([]);
      expect(crossed.total).toBe(0);
      expect(crossed.counts.all).toBe(0);
      const own = (await detail(other.actor, otherCid, q())).enrollments;
      expect(own.counts.all).toBe(7);
      expect(own.counts.in_sequence).toBe(7);
    });
  });

  describe("linkedin", () => {
    let t: Awaited<ReturnType<typeof org>>;
    let other: Awaited<ReturnType<typeof org>>;
    let cid: string;
    let ids: string[];
    const deps = () => ({ campaigns: linkedinStore, admin: drizzleEnrollmentAdminStore }) as unknown as import("../../linkedin/application/linkedin-campaigns").LinkedInCampaignDeps;
    const detailOf = (actor: Actor, id: string, query: EnrollmentListQuery) => linkedin.getLinkedInCampaignDetail(deps(), actor, id, query);

    beforeAll(async () => {
      t = await org();
      other = await org();
      cid = await campaign(t.id, "linkedin");
      const people = Array.from({ length: 120 }, (_, i) => ({
        name: `Prospect ${String(i).padStart(3, "0")}`,
        status: STATUS_CYCLE[i % STATUS_CYCLE.length],
        title: i % 2 === 0 ? "Head of Growth" : "Founder",
        company: i % 3 === 0 ? "Globex" : "Initech",
      }));
      ids = await enroll(t.id, cid, "linkedin", people);
      const [account] = await sql`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, name, status) values (${t.id}, ${"pa-" + Math.random()}, ${"li-" + Math.random()}, 'Sender Sam', 'connected') returning id`;
      await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, resolve_last_error) values (${ids[0]}, ${t.id}, 'profile not found')`;
      await sql`update campaign_enrollments set linkedin_account_id = ${account.id}, current_step = 2 where id = ${ids[1]}`;
      await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id) values (${ids[1]}, ${t.id})`;
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, attempt, sent_at, body, linkedin_account_id) values (${t.id}, ${ids[1]}, 1, 'linkedin', 'sent', 2, now(), 'Hi Prospect', ${account.id})`;
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, attempt, error) values (${t.id}, ${ids[1]}, 2, 'linkedin', 'failed', 3, 'rate limited')`;
    });

    it("counts, filters and searches like the email table", async () => {
      const whole = (await detailOf(t.actor, cid, q())).enrollments.counts;
      const removed = Array.from({ length: 120 }, (_, i) => i).filter((i) => i % 9 === 8).length;
      expect(whole.all).toBe(120 - removed);
      expect(whole.removed).toBe(removed);
      const stopped = await detailOf(t.actor, cid, q({ tab: "stopped", pageSize: 100 }));
      expect(stopped.enrollments.total).toBe(whole.stopped);
      expect(stopped.enrollments.counts).toEqual(whole);
      const globex = await detailOf(t.actor, cid, q({ search: "globex", pageSize: 100 }));
      expect(globex.enrollments.total).toBe(Array.from({ length: 120 }, (_, i) => i).filter((i) => i % 3 === 0 && i % 9 !== 8).length);
      const growthPending = await detailOf(t.actor, cid, q({ search: "head of growth", tab: "queued", pageSize: 100 }));
      expect(growthPending.enrollments.total).toBe(Array.from({ length: 120 }, (_, i) => i).filter((i) => i % 2 === 0 && i % 9 === 0).length);
      expect((await detailOf(t.actor, cid, q({ search: "%" }))).enrollments.total).toBe(0);
    });

    it("pages 120 rows without gaps or repeats", async () => {
      const all = (await sql`select id from campaign_enrollments where campaign_id = ${cid} and status <> 'removed' order by created_at desc, id desc`).map((r) => r.id as string);
      for (const pageSize of [20, 50, 100] as const) {
        const seen: string[] = [];
        for (let page = 1; page <= Math.ceil(all.length / pageSize) + 1; page += 1) {
          seen.push(...(await detailOf(t.actor, cid, q({ page, pageSize }))).enrollments.rows.map((r) => r.enrollmentId));
        }
        expect(seen, `size ${pageSize}`).toEqual(all);
      }
    });

    it("fills the row panel with sends, retries, last error, step and account", async () => {
      const rows = (await detailOf(t.actor, cid, q({ search: "Prospect 001", pageSize: 20 }))).enrollments.rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].currentStep).toBe(2);
      expect(rows[0].detail).toMatchObject({ accountName: "Sender Sam", retries: 3, lastError: "rate limited", headline: "Founder", companyName: "Initech" });
      expect(rows[0].detail.sends.map((s) => [s.stepNumber, s.status])).toEqual([[1, "sent"], [2, "failed"]]);
      const lookup = (await detailOf(t.actor, cid, q({ search: "Prospect 000" }))).enrollments.rows[0];
      expect(lookup.detail).toMatchObject({ lastError: "profile not found", retries: 0, accountName: null, sends: [] });
    });

    it("does not leak sends or counts across organizations and 404s for a foreign campaign", async () => {
      await expect(detailOf(other.actor, cid, q())).rejects.toBeInstanceOf(NotFoundError);
      const crossed = await linkedinStore.listEnrollments(other.id, cid, q());
      expect(crossed).toMatchObject({ rows: [], total: 0 });
      expect(crossed.counts.all).toBe(0);
      // An email campaign id is not a LinkedIn campaign: the lookup misses it.
      const emailCampaign = await campaign(t.id, "email");
      await expect(detailOf(t.actor, emailCampaign, q())).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
