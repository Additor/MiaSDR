import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, waitForLockWaiters } from "@/test-support/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import type { SearchItem, SearchPage } from "../../application/linkedin-ports";
import type { LinkedInSearchBatchDeps, LinkedInSearchEngineDeps } from "../../application/linkedin-search-ports";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

const searchUrl = (n: number | string) => `https://www.linkedin.com/search/results/people/?keywords=m${n}`;
const start = new Date("2026-10-14T10:00:00Z");
const HEADERS = ["company_name", "search_url"];
const UNKNOWN = "11111111-1111-4111-8111-111111111111";

describeDb("linkedin search batch management", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let batchUc: typeof import("../../application/linkedin-search-batch");
  let engine: typeof import("../../application/run-linkedin-search");
  let engineStore: typeof import("../drizzle-linkedin-search-store").drizzleLinkedInSearchEngineStore;
  let batchStore: typeof import("../drizzle-linkedin-search-batch-store").drizzleLinkedInSearchBatchStore;
  let campaignStore: typeof import("../drizzle-linkedin-campaign-store").drizzleLinkedInCampaignStore;
  let sink: typeof import("../search-lead-sink").searchLeadSink;
  const cleanup: string[] = [];
  const users: string[] = [];

  let current = start;
  const clock = { now: () => current };
  const advance = (seconds: number) => {
    current = new Date(current.getTime() + seconds * 1000);
  };

  const pages = (tag: string, count: number, size = 10): SearchPage[] => {
    const out: SearchPage[] = [];
    for (let first = 0; first < count; first += size) {
      const items: SearchItem[] = [];
      for (let i = first; i < Math.min(first + size, count); i++) {
        items.push({ identifier: `p${i}-${tag}`, profileUrl: `https://www.linkedin.com/in/p${i}-${tag}`, name: `Person${i} Tester`, headline: `Role ${i}`, location: "Berlin", networkDistance: "DISTANCE_2", raw: { i } });
      }
      out.push({ items, nextCursor: first + size < count ? String(out.length + 1) : null, totalEstimate: count });
    }
    return out;
  };

  async function fixture(options: { accounts?: number; people?: number } = {}) {
    current = start;
    // The claim looks across organizations, so searches left by earlier tests must not be due.
    await sql`update linkedin_search_queries set status = 'cancelled' where status in ('queued', 'running', 'paused', 'paused_limit')`;
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('M', ${"sm-" + tag}) returning id`;
    cleanup.push(org);
    const [{ id: userId }] = await sql`insert into users (name, email) values ('Uploader', ${`u-${tag}@manage.test`}) returning id`;
    const [{ id: otherUserId }] = await sql`insert into users (name, email) values ('Colleague', ${`c-${tag}@manage.test`}) returning id`;
    users.push(userId, otherUserId);
    for (let i = 0; i < (options.accounts ?? 1); i++) {
      await sql`
        insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, name, status, created_at)
        values (${org}, ${`acct${i}-${tag}`}, ${`ACo${i}-${tag}`}, ${`owner${i}-${tag}`}, ${`Owner ${i}`}, 'connected', ${new Date(start.getTime() + i * 1000)})`;
    }
    const gateway = new FakeLinkedInGateway();
    gateway.searchPages = pages(tag, options.people ?? 12);
    const deps: LinkedInSearchEngineDeps = { store: engineStore, gateways: gateway, sink, clock, random: () => 0 };
    const batchDeps: LinkedInSearchBatchDeps = { batches: batchStore, campaigns: campaignStore };
    const actor: Actor = { userId, organizationId: org, role: "member" };
    const admin: Actor = { userId: otherUserId, organizationId: org, role: "admin" };
    const colleague: Actor = { userId: otherUserId, organizationId: org, role: "member" };
    return { org, tag, gateway, deps, batchDeps, actor, admin, colleague };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const upload = (f: Fixture, urls: string[], extra: Partial<Parameters<typeof batchUc.uploadLinkedInSearchBatch>[2]> = {}) =>
    batchUc.uploadLinkedInSearchBatch(f.batchDeps, f.actor, {
      name: "Manage list",
      filename: "list.csv",
      headers: HEADERS,
      rows: urls.map((u) => ({ company_name: "", search_url: u })),
      maxResults: 25,
      ...extra,
    });
  const queries = (batchId: string) => sql`select * from linkedin_search_queries where batch_id = ${batchId} order by created_at, url`;
  const results = async (batchId: string) => (await sql`select count(*)::int as n from linkedin_search_results r join linkedin_search_queries q on q.id = r.query_id where q.batch_id = ${batchId}`)[0].n as number;
  const audit = (org: string) => sql`select action, actor_user_id, entity_id, meta from audit_log where organization_id = ${org} and action like 'search_batch.%' order by created_at, action`;
  const runAll = async (f: Fixture, max = 40) => {
    for (let i = 0; i < max; i++) {
      const outcome = await engine.runNextSearchPage(f.deps);
      advance(10);
      if (outcome.kind === "idle") return;
    }
  };
  const people = async (org: string) => (await sql`select count(*)::int as n from people where organization_id = ${org}`)[0].n as number;

  beforeAll(async () => {
    batchUc = await import("../../application/linkedin-search-batch");
    engine = await import("../../application/run-linkedin-search");
    ({ drizzleLinkedInSearchEngineStore: engineStore } = await import("../drizzle-linkedin-search-store"));
    ({ drizzleLinkedInSearchBatchStore: batchStore } = await import("../drizzle-linkedin-search-batch-store"));
    ({ drizzleLinkedInCampaignStore: campaignStore } = await import("../drizzle-linkedin-campaign-store"));
    ({ searchLeadSink: sink } = await import("../search-lead-sink"));
  });

  afterAll(async () => {
    await dropOrgs(sql, cleanup.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  describe("add URLs", () => {
    it("queues new searches with the limit and campaign of the batch and counts the repeats", async () => {
      const f = await fixture();
      const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'linkedin', 'Target', 'draft', '[]') returning id`;
      const report = await upload(f, [searchUrl(1), searchUrl(2)], { campaignId: campaign });
      const added = await batchUc.addSearchBatchUrls(f.batchDeps, f.actor, report.id, [searchUrl(3), searchUrl(1) + "&origin=GLOBAL_SEARCH_HEADER", searchUrl(3), "https://www.linkedin.com/in/someone", searchUrl(4), "", " "]);
      // The repeat of search 1 waits in this very batch, so it counts as already queued.
      expect(added).toMatchObject({ added: 2, alreadyInBatch: 0, alreadyQueued: 1, duplicatesInList: 1, rejectedCount: 1, total: 4 });
      expect(added.rejected.map((r) => r.row)).toEqual([4]);
      const rows = await queries(report.id);
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row).toMatchObject({ status: "queued", max_results: 25, target_campaign_id: campaign });
    });

    it("skips a search that waits in another batch, and refuses a paste with nothing usable", async () => {
      const f = await fixture();
      const first = await upload(f, [searchUrl(10)]);
      const second = await upload(f, [searchUrl(11)]);
      await expect(batchUc.addSearchBatchUrls(f.batchDeps, f.actor, second.id, [searchUrl(10)])).rejects.toThrow(/already in the queue/);
      await expect(batchUc.addSearchBatchUrls(f.batchDeps, f.actor, second.id, ["https://example.com/", " "])).rejects.toBeInstanceOf(ValidationError);
      await expect(batchUc.addSearchBatchUrls(f.batchDeps, f.actor, second.id, [])).rejects.toBeInstanceOf(ValidationError);
      expect((await queries(first.id)).length + (await queries(second.id)).length).toBe(2);
    });

    it("counts a URL whose search in the batch was cancelled, and refuses a batch of another organization", async () => {
      const f = await fixture();
      const other = await fixture();
      const report = await upload(f, [searchUrl(20)]);
      await sql`update linkedin_search_queries set status = 'cancelled' where batch_id = ${report.id}`;
      const added = await batchUc.addSearchBatchUrls(f.batchDeps, f.actor, report.id, [searchUrl(20)]);
      // The batch still holds the cancelled search of that URL, so the unique key counts it and adds nothing.
      expect(added).toMatchObject({ added: 0, alreadyInBatch: 1 });
      await expect(batchUc.addSearchBatchUrls(f.batchDeps, other.actor, report.id, [searchUrl(21)])).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses to grow a batch past the limit and adds nothing", async () => {
      const f = await fixture();
      const report = await upload(f, [searchUrl(30)]);
      // Fill the batch to 999 searches directly, then ask for two more.
      await sql`
        insert into linkedin_search_queries (organization_id, batch_id, url, status, max_results)
        select ${f.org}, ${report.id}, 'https://www.linkedin.com/search/results/people/?keywords=fill' || g, 'cancelled', 25 from generate_series(1, 998) g`;
      await expect(batchUc.addSearchBatchUrls(f.batchDeps, f.actor, report.id, [searchUrl(31), searchUrl(32)])).rejects.toBeInstanceOf(ConflictError);
      expect((await queries(report.id)).length).toBe(999);
      expect(await batchUc.addSearchBatchUrls(f.batchDeps, f.actor, report.id, [searchUrl(33)])).toMatchObject({ added: 1, total: 1000 });
    });

    it("refuses when the batch campaign is completed", async () => {
      const f = await fixture();
      const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'linkedin', 'Done', 'draft', '[]') returning id`;
      const report = await upload(f, [searchUrl(40)], { campaignId: campaign });
      await sql`update campaigns set status = 'completed' where id = ${campaign}`;
      await expect(batchUc.addSearchBatchUrls(f.batchDeps, f.actor, report.id, [searchUrl(41)])).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe("remove URLs and delete results", () => {
    async function ranBatch(f: Fixture) {
      const report = await upload(f, [searchUrl(50), searchUrl(51)], { maxResults: 12 });
      await runAll(f);
      return report;
    }

    it("deletes the searches and their staged results, and keeps the leads", async () => {
      const f = await fixture();
      const report = await ranBatch(f);
      const [a, b] = await queries(report.id);
      const before = { results: await results(report.id), people: await people(f.org) };
      expect(before.results).toBeGreaterThan(0);
      expect(before.people).toBeGreaterThan(0);

      const out = await batchUc.removeSearchBatchUrls(f.batchDeps, f.actor, report.id, [a.id as string, UNKNOWN]);
      expect(out).toEqual({ removed: 1, resultsRemoved: Number(a.leads_fetched), notFound: 1 });
      expect((await queries(report.id)).map((r) => r.id)).toEqual([b.id]);
      expect(await people(f.org)).toBe(before.people);
      const [entry] = await audit(f.org);
      expect(entry).toMatchObject({ action: "search_batch.urls_removed", actor_user_id: f.actor.userId, entity_id: report.id });
      expect(entry.meta).toMatchObject({ removed: 1, resultsRemoved: Number(a.leads_fetched) });
    });

    it("keeps imported leads and their enrollments when their search goes", async () => {
      const f = await fixture();
      const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'linkedin', 'Fill', 'draft', '[]') returning id`;
      const report = await upload(f, [searchUrl(55)], { maxResults: 10, campaignId: campaign });
      await runAll(f);
      const enrolled = (await sql`select count(*)::int as n from campaign_enrollments where campaign_id = ${campaign}`)[0].n as number;
      expect(enrolled).toBeGreaterThan(0);
      const [query] = await queries(report.id);
      await batchUc.removeSearchBatchUrls(f.batchDeps, f.actor, report.id, [query.id as string]);
      expect((await sql`select count(*)::int as n from campaign_enrollments where campaign_id = ${campaign}`)[0].n).toBe(enrolled);
      expect(await people(f.org)).toBe(enrolled);
    });

    it("answers 409 and deletes nothing while a named search is running", async () => {
      const f = await fixture();
      const report = await ranBatch(f);
      const [a, b] = await queries(report.id);
      await sql`update linkedin_search_queries set status = 'running' where id = ${b.id}`;
      const before = await results(report.id);
      await expect(batchUc.removeSearchBatchUrls(f.batchDeps, f.actor, report.id, [a.id as string, b.id as string])).rejects.toThrow("This search is still running");
      await expect(batchUc.deleteSearchBatchResults(f.batchDeps, f.actor, report.id)).rejects.toBeInstanceOf(ConflictError);
      await expect(batchUc.deleteSearchBatch(f.batchDeps, f.actor, report.id)).rejects.toBeInstanceOf(ConflictError);
      expect(await results(report.id)).toBe(before);
      expect(await queries(report.id)).toHaveLength(2);
      expect(await audit(f.org)).toHaveLength(0);
      // A search that is not named may stay running.
      expect(await batchUc.removeSearchBatchUrls(f.batchDeps, f.actor, report.id, [a.id as string])).toMatchObject({ removed: 1 });
    });

    it("waits for a claim in progress and then sees the running status it set", async () => {
      const f = await fixture();
      const report = await upload(f, [searchUrl(65)]);
      const [query] = await queries(report.id);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      // What claimPage does: lock the row, set `running`, commit later.
      const claim = sql.begin(async (tx) => {
        await tx`select id from linkedin_search_queries where id = ${query.id} for update`;
        await tx`update linkedin_search_queries set status = 'running', lease_until = now() + interval '2 minutes' where id = ${query.id}`;
        locked();
        await gate;
      });
      await lockTaken;
      let settled = false;
      const removal = batchUc.removeSearchBatchUrls(f.batchDeps, f.actor, report.id, [query.id as string]).then(
        () => (settled = true, "removed"),
        (error: unknown) => (settled = true, error),
      );
      await waitForLockWaiters(sql, 1);
      expect(settled).toBe(false);
      release();
      await claim;
      expect(await removal).toBeInstanceOf(ConflictError);
      expect(await queries(report.id)).toHaveLength(1);
    });

    it("lets a cancelled search go, and drops the page that was in flight", async () => {
      const f = await fixture();
      const report = await upload(f, [searchUrl(60)], { maxResults: 12 });
      const [query] = await queries(report.id);
      f.gateway.searchPages = pages(f.tag, 12);
      // Claim a page, cancel while the provider call "runs", then try to store it.
      const claim = await engineStore.claimPage({ now: current, random: () => 0 });
      expect(claim?.searchId).toBe(query.id);
      await sql`update linkedin_search_queries set status = 'cancelled' where id = ${query.id}`;
      await expect(batchUc.removeSearchBatchUrls(f.batchDeps, f.actor, report.id, [query.id as string])).resolves.toMatchObject({ removed: 1 });
      expect(await engineStore.isCurrent(claim!)).toBe(false);
      expect(await results(report.id)).toBe(0);
    });

    it("deletes staged results by URL and keeps the search and its lifetime counters", async () => {
      const f = await fixture();
      const report = await ranBatch(f);
      const [a, b] = await queries(report.id);
      const out = await batchUc.deleteSearchBatchResults(f.batchDeps, f.actor, report.id, [a.id as string]);
      expect(out).toEqual({ searches: 1, resultsRemoved: Number(a.leads_fetched), notFound: 0 });
      const [afterA, afterB] = await sql`select id, leads_fetched, imported_count, status from linkedin_search_queries where id in (${a.id}, ${b.id}) order by created_at, url`;
      expect(afterA).toMatchObject({ leads_fetched: Number(a.leads_fetched), imported_count: Number(a.imported_count), status: "completed" });
      expect(Number(afterB.leads_fetched)).toBe(Number(b.leads_fetched));
      expect((await sql`select count(*)::int as n from linkedin_search_results where query_id = ${a.id}`)[0].n).toBe(0);
      expect((await sql`select count(*)::int as n from linkedin_search_results where query_id = ${b.id}`)[0].n).toBe(Number(b.leads_fetched));

      const all = await batchUc.deleteSearchBatchResults(f.batchDeps, f.actor, report.id);
      expect(all.searches).toBe(2);
      expect(await results(report.id)).toBe(0);
      expect((await audit(f.org)).map((r) => r.action)).toEqual(["search_batch.results_deleted", "search_batch.results_deleted"]);
    });

    it("does not let a resumed search fetch past max_results after its results were deleted", async () => {
      const f = await fixture({ people: 30 });
      const report = await upload(f, [searchUrl(70)], { maxResults: 12 });
      const [query] = await queries(report.id);
      // One page of 10 is stored; the search then pauses (the Pause button), its results are deleted and it resumes.
      expect((await engine.runNextSearchPage(f.deps)).kind).not.toBe("idle");
      advance(10);
      await sql`update linkedin_search_queries set status = 'paused' where id = ${query.id}`;
      await batchUc.deleteSearchBatchResults(f.batchDeps, f.actor, report.id, [query.id as string]);
      await batchUc.runSearchBatch(f.batchDeps, f.actor, report.id);
      await runAll(f);
      const [after] = await queries(report.id);
      // The allowance of 12 is spent once: 10 before the delete, 2 after. Zeroing the counter would let it fetch 12 more.
      expect(Number(after.leads_fetched)).toBe(12);
      expect(await results(report.id)).toBe(2);
    });

    it("keeps the batch's result limit and campaign when every search was removed before more were added", async () => {
      const f = await fixture();
      const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'linkedin', 'Kept', 'draft', '[]') returning id`;
      const report = await upload(f, [searchUrl(80), searchUrl(81)], { maxResults: 17, campaignId: campaign });
      const all = (await queries(report.id)).map((r) => r.id as string);
      await batchUc.removeSearchBatchUrls(f.batchDeps, f.actor, report.id, all);
      expect(await queries(report.id)).toHaveLength(0);
      await batchUc.addSearchBatchUrls(f.batchDeps, f.actor, report.id, [searchUrl(82)]);
      const [added] = await queries(report.id);
      expect(added).toMatchObject({ max_results: 17, target_campaign_id: campaign });
      expect((await batchUc.getLinkedInSearchBatch(f.batchDeps, f.actor, report.id)).maxResults).toBe(17);
    });

    it("counts a search of another batch as not found and deletes nothing there", async () => {
      const f = await fixture();
      const one = await upload(f, [searchUrl(70)]);
      const two = await upload(f, [searchUrl(71)]);
      const [foreign] = await queries(two.id);
      const out = await batchUc.removeSearchBatchUrls(f.batchDeps, f.actor, one.id, [foreign.id as string]);
      expect(out).toEqual({ removed: 0, resultsRemoved: 0, notFound: 1 });
      expect(await queries(two.id)).toHaveLength(1);
      expect(await audit(f.org)).toHaveLength(0);
    });
  });

  describe("delete the batch", () => {
    it("removes the batch, its searches and staged results, and keeps leads and enrollments", async () => {
      const f = await fixture();
      const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'linkedin', 'Keep', 'draft', '[]') returning id`;
      const report = await upload(f, [searchUrl(80), searchUrl(81)], { maxResults: 12, campaignId: campaign });
      await runAll(f);
      const peopleBefore = await people(f.org);
      const enrolled = (await sql`select count(*)::int as n from campaign_enrollments where campaign_id = ${campaign}`)[0].n;
      const resultsBefore = await results(report.id);
      expect(resultsBefore).toBeGreaterThan(0);

      const out = await batchUc.deleteSearchBatch(f.batchDeps, f.actor, report.id);
      expect(out).toEqual({ searches: 2, resultsRemoved: resultsBefore });
      expect((await sql`select count(*)::int as n from linkedin_search_batches where id = ${report.id}`)[0].n).toBe(0);
      expect((await sql`select count(*)::int as n from linkedin_search_queries where batch_id = ${report.id}`)[0].n).toBe(0);
      expect(await people(f.org)).toBe(peopleBefore);
      expect((await sql`select count(*)::int as n from campaign_enrollments where campaign_id = ${campaign}`)[0].n).toBe(enrolled);
      await expect(batchUc.getLinkedInSearchBatch(f.batchDeps, f.actor, report.id)).rejects.toBeInstanceOf(NotFoundError);
      const [entry] = await audit(f.org);
      expect(entry).toMatchObject({ action: "search_batch.deleted", entity_id: report.id });
      expect(entry.meta).toMatchObject({ name: "Manage list", searches: 2, resultsRemoved: resultsBefore });
    });

    it("does not touch the engine's claim of a search in another batch", async () => {
      const f = await fixture();
      const one = await upload(f, [searchUrl(90)]);
      const two = await upload(f, [searchUrl(91)]);
      await batchUc.deleteSearchBatch(f.batchDeps, f.actor, one.id);
      expect(await queries(two.id)).toHaveLength(1);
    });
  });

  describe("permissions", () => {
    it("lets the uploader and an admin delete, and refuses another member", async () => {
      const f = await fixture();
      const report = await upload(f, [searchUrl(100), searchUrl(101), searchUrl(102)]);
      const [a, b] = await queries(report.id);
      await expect(batchUc.removeSearchBatchUrls(f.batchDeps, f.colleague, report.id, [a.id as string])).rejects.toBeInstanceOf(ForbiddenError);
      await expect(batchUc.deleteSearchBatchResults(f.batchDeps, f.colleague, report.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(batchUc.deleteSearchBatch(f.batchDeps, f.colleague, report.id)).rejects.toBeInstanceOf(ForbiddenError);
      expect(await queries(report.id)).toHaveLength(3);
      await expect(batchUc.removeSearchBatchUrls(f.batchDeps, f.admin, report.id, [a.id as string])).resolves.toMatchObject({ removed: 1 });
      await expect(batchUc.removeSearchBatchUrls(f.batchDeps, f.actor, report.id, [b.id as string])).resolves.toMatchObject({ removed: 1 });
      await expect(batchUc.deleteSearchBatch(f.batchDeps, f.admin, report.id)).resolves.toMatchObject({ searches: 1 });
    });

    it("lets any member add URLs and run", async () => {
      const f = await fixture();
      const report = await upload(f, [searchUrl(110)]);
      await expect(batchUc.addSearchBatchUrls(f.batchDeps, f.colleague, report.id, [searchUrl(111)])).resolves.toMatchObject({ added: 1 });
      await expect(batchUc.runSearchBatch(f.batchDeps, f.colleague, report.id)).resolves.toMatchObject({ queued: 2 });
    });
  });

  describe("run now", () => {
    it("returns paused searches to the queue and clears the gap of queued ones", async () => {
      const f = await fixture();
      const report = await upload(f, [searchUrl(120), searchUrl(121), searchUrl(122), searchUrl(123), searchUrl(124)]);
      const [paused, gap, failed, done, running] = await queries(report.id);
      await sql`update linkedin_search_queries set status = 'paused', last_error = 'old', failures = 2 where id = ${paused.id}`;
      await sql`update linkedin_search_queries set next_page_at = now() + interval '1 hour' where id = ${gap.id}`;
      await sql`update linkedin_search_queries set status = 'failed' where id = ${failed.id}`;
      await sql`update linkedin_search_queries set status = 'completed' where id = ${done.id}`;
      await sql`update linkedin_search_queries set status = 'running', lease_until = now() + interval '1 minute' where id = ${running.id}`;

      expect(await batchUc.runSearchBatch(f.batchDeps, f.actor, report.id)).toEqual({ queued: 2 });
      const byId = new Map((await queries(report.id)).map((r) => [r.id, r]));
      expect(byId.get(paused.id)).toMatchObject({ status: "queued", last_error: null, failures: 0, next_page_at: null });
      expect(byId.get(gap.id)).toMatchObject({ status: "queued", next_page_at: null });
      expect(byId.get(failed.id)?.status).toBe("failed");
      expect(byId.get(done.id)?.status).toBe("completed");
      expect(byId.get(running.id)?.status).toBe("running");
    });

    it("runs only the selected searches, and the engine picks them up afterwards", async () => {
      const f = await fixture();
      const report = await upload(f, [searchUrl(130), searchUrl(131)], { maxResults: 10 });
      const [a, b] = await queries(report.id);
      await sql`update linkedin_search_queries set status = 'paused' where batch_id = ${report.id}`;
      expect(await engine.runNextSearchPage(f.deps)).toEqual({ kind: "idle" });
      expect(await batchUc.runSearchBatch(f.batchDeps, f.actor, report.id, [a.id as string])).toEqual({ queued: 1 });
      const outcome = await engine.runNextSearchPage(f.deps);
      expect(outcome.kind).toBe("page");
      const [afterA, afterB] = await sql`select id, status, leads_fetched from linkedin_search_queries where id in (${a.id}, ${b.id}) order by created_at, url`;
      expect(Number(afterA.leads_fetched)).toBeGreaterThan(0);
      expect(afterB).toMatchObject({ status: "paused", leads_fetched: 0 });
    });

    it("does not lift the daily allowance: an exhausted account leaves the search waiting for the limit", async () => {
      const f = await fixture();
      const report = await upload(f, [searchUrl(140)], { maxResults: 10 });
      await sql`update linkedin_accounts set search_leads_today = 10000, search_day = ${current.toISOString().slice(0, 10)} where organization_id = ${f.org}`;
      await sql`update linkedin_search_queries set status = 'paused' where batch_id = ${report.id}`;
      await batchUc.runSearchBatch(f.batchDeps, f.actor, report.id);
      expect(await engine.runNextSearchPage(f.deps)).toEqual({ kind: "idle" });
      expect((await queries(report.id))[0]).toMatchObject({ status: "paused_limit", leads_fetched: 0 });
    });
  });
});
