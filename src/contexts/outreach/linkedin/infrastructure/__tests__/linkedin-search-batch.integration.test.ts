import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import type { SearchItem, SearchPage } from "../../application/linkedin-ports";
import type { LinkedInSearchBatchDeps, LinkedInSearchEngineDeps } from "../../application/linkedin-search-ports";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

const searchUrl = (n: number | string) => `https://www.linkedin.com/search/results/people/?keywords=q${n}`;
const start = new Date("2026-10-14T10:00:00Z");
const HEADERS = ["company_name", "search_url"];

describeDb("linkedin search batch upload", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let batchUc: typeof import("../../application/linkedin-search-batch");
  let engine: typeof import("../../application/run-linkedin-search");
  let engineStore: typeof import("../drizzle-linkedin-search-store").drizzleLinkedInSearchEngineStore;
  let batchStore: typeof import("../drizzle-linkedin-search-batch-store").drizzleLinkedInSearchBatchStore;
  let searchStore: typeof import("../drizzle-linkedin-search-store").drizzleLinkedInSearchStore;
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
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('B', ${"sb-" + tag}) returning id`;
    cleanup.push(org);
    const [{ id: userId }] = await sql`insert into users (name, email) values ('Uploader', ${`u-${tag}@batch.test`}) returning id`;
    users.push(userId);
    const accounts: Array<{ id: string; ref: string }> = [];
    for (let i = 0; i < (options.accounts ?? 1); i++) {
      const [{ id }] = await sql`
        insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, name, status, created_at)
        values (${org}, ${`acct${i}-${tag}`}, ${`ACo${i}-${tag}`}, ${`owner${i}-${tag}`}, ${`Owner ${i}`}, 'connected', ${new Date(start.getTime() + i * 1000)}) returning id`;
      accounts.push({ id, ref: `acct${i}-${tag}` });
    }
    const gateway = new FakeLinkedInGateway();
    gateway.searchPages = pages(tag, options.people ?? 12);
    const deps: LinkedInSearchEngineDeps = { store: engineStore, gateways: gateway, sink, clock, random: () => 0 };
    const batchDeps: LinkedInSearchBatchDeps = { batches: batchStore, campaigns: campaignStore };
    const actor: Actor = { userId, organizationId: org, role: "owner" };
    return { org, tag, accounts, gateway, deps, batchDeps, actor };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const upload = (f: Fixture, urls: Array<string | [string, string]>, extra: Partial<Parameters<typeof batchUc.uploadLinkedInSearchBatch>[2]> = {}) =>
    batchUc.uploadLinkedInSearchBatch(f.batchDeps, f.actor, {
      name: "Berlin list",
      filename: "list.csv",
      headers: HEADERS,
      rows: urls.map((u) => (Array.isArray(u) ? { company_name: u[0], search_url: u[1] } : { company_name: "", search_url: u })),
      ...extra,
    });
  const queries = async (batchId: string) => await sql`select * from linkedin_search_queries where batch_id = ${batchId} order by source_row`;
  const page = async (f: Fixture) => {
    const outcome = await engine.runNextSearchPage(f.deps);
    advance(10);
    return outcome;
  };
  const runAll = async (f: Fixture, max = 40) => {
    for (let i = 0; i < max; i++) if ((await page(f)).kind === "idle") return;
  };

  beforeAll(async () => {
    batchUc = await import("../../application/linkedin-search-batch");
    engine = await import("../../application/run-linkedin-search");
    ({ drizzleLinkedInSearchEngineStore: engineStore, drizzleLinkedInSearchStore: searchStore } = await import("../drizzle-linkedin-search-store"));
    ({ drizzleLinkedInSearchBatchStore: batchStore } = await import("../drizzle-linkedin-search-batch-store"));
    ({ drizzleLinkedInCampaignStore: campaignStore } = await import("../drizzle-linkedin-campaign-store"));
    ({ searchLeadSink: sink } = await import("../search-lead-sink"));
  });

  afterAll(async () => {
    await dropOrgs(sql, cleanup.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("creates a bulk batch with one queued search per accepted row and keeps the upload report", async () => {
    const f = await fixture();
    const report = await upload(f, [["Acme", searchUrl(1)], searchUrl(2), "https://www.linkedin.com/in/someone", searchUrl(1) + "&origin=GLOBAL_SEARCH_HEADER", ""], { maxResults: 30 });
    expect(report).toMatchObject({ queued: 2, duplicatesInFile: 1, alreadyQueued: 0, rejectedCount: 2 });
    expect(report.rejected.map((r) => r.row)).toEqual([4, 6]);

    const [batch] = await sql`select * from linkedin_search_batches where id = ${report.id}`;
    expect(batch).toMatchObject({ organization_id: f.org, kind: "bulk", name: "Berlin list", source_filename: "list.csv", rows_total: 5, rows_rejected: 2, created_by: f.actor.userId });
    expect(batch.rejections).toHaveLength(2);
    const rows = await queries(report.id);
    expect(rows.map((r) => [r.source_row, r.company_name, r.status, r.max_results])).toEqual([
      [2, "Acme", "queued", 30],
      [3, null, "queued", 30],
    ]);
  });

  it("queues nothing when no row is usable, and when every search is already queued", async () => {
    const f = await fixture();
    await expect(upload(f, ["https://example.com/", ""])).rejects.toBeInstanceOf(ValidationError);
    expect((await sql`select count(*)::int as n from linkedin_search_batches where organization_id = ${f.org}`)[0].n).toBe(0);

    await upload(f, [searchUrl(1), searchUrl(2)]);
    // A second upload skips the two that wait in the queue and queues the new one.
    const again = await upload(f, [searchUrl(2), searchUrl(3)], { name: "Second" });
    expect(again).toMatchObject({ queued: 1, alreadyQueued: 1 });
    await expect(upload(f, [searchUrl(1)], { name: "Third" })).rejects.toThrow(/already in the queue/);
    expect((await sql`select count(*)::int as n from linkedin_search_batches where organization_id = ${f.org}`)[0].n).toBe(2);
  });

  it("lets the database refuse one URL twice in a batch", async () => {
    const f = await fixture();
    const { id } = await upload(f, [searchUrl(1)]);
    await expect(sql`insert into linkedin_search_queries (organization_id, batch_id, url) values (${f.org}, ${id}, ${searchUrl(1)})`).rejects.toThrow(/batch_url_uq/);
  });

  it("refuses accounts and campaigns of another organization", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(upload(f, [searchUrl(1)], { accountIds: [other.accounts[0].id] })).rejects.toBeInstanceOf(ValidationError);
    await expect(upload(f, [searchUrl(1)], { accountIds: ["not-a-uuid"] })).rejects.toBeInstanceOf(ValidationError);
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, name, channel, status) values (${other.org}, 'Theirs', 'linkedin', 'draft') returning id`;
    await expect(upload(f, [searchUrl(1)], { campaignId: campaign })).rejects.toBeInstanceOf(NotFoundError);
    expect((await sql`select count(*)::int as n from linkedin_search_batches where organization_id = ${f.org}`)[0].n).toBe(0);
  });

  it("runs every search of a batch through the normal queue, spreading two workers over two accounts", async () => {
    const f = await fixture({ accounts: 2, people: 5 });
    const { id } = await upload(f, [searchUrl(1), searchUrl(2), searchUrl(3)]);

    const claims = await Promise.all([engineStore.claimPage({ now: current, random: () => 0 }), engineStore.claimPage({ now: current, random: () => 0 })]);
    expect(claims.filter(Boolean)).toHaveLength(2);
    const [a, b] = claims as NonNullable<(typeof claims)[number]>[];
    expect(a.searchId).not.toBe(b.searchId);
    expect(a.account.id).not.toBe(b.account.id);
    // Hand the claims back so the loop below can run them.
    await engineStore.release(a, { error: null, retryAt: null, unknownFailure: false });
    await engineStore.release(b, { error: null, retryAt: null, unknownFailure: false });

    advance(60);
    await runAll(f);
    const rows = await queries(id);
    expect(rows.map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
    expect(rows.map((r) => r.leads_fetched)).toEqual([5, 5, 5]);
  });

  it("honors the account list of the batch", async () => {
    const f = await fixture({ accounts: 2, people: 5 });
    const { id } = await upload(f, [searchUrl(1), searchUrl(2)], { accountIds: [f.accounts[1].id] });
    await runAll(f);
    expect((await queries(id)).map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(new Set(f.gateway.searchLog.map((c) => c.account))).toEqual(new Set([f.accounts[1].ref]));
  });

  it("waits, with a reason, when none of the batch's accounts is connected", async () => {
    const f = await fixture({ accounts: 2, people: 5 });
    const { id } = await upload(f, [searchUrl(1)], { accountIds: [f.accounts[1].id] });
    await sql`update linkedin_accounts set status = 'disconnected' where id = ${f.accounts[1].id}`;
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
    expect((await queries(id))[0]).toMatchObject({ status: "queued", last_error: "None of this batch's LinkedIn accounts is connected." });
  });

  it("reruns only failed searches, once", async () => {
    const f = await fixture({ people: 5 });
    f.gateway.searchBehavior = ({ url: u }) => (u.includes("bad") ? { refuse: "rejected" } : "ok");
    const { id } = await upload(f, [searchUrl("bad1"), searchUrl("bad2"), searchUrl("good")]);
    await runAll(f);
    expect((await queries(id)).map((r) => r.status).sort()).toEqual(["completed", "failed", "failed"]);

    const detail = await batchUc.getLinkedInSearchBatch(f.batchDeps, f.actor, id);
    expect(detail.statuses).toMatchObject({ completed: 1, failed: 2 });
    const failedIds = detail.items.filter((i) => i.status === "failed").map((i) => i.id);
    const completedId = detail.items.find((i) => i.status === "completed")!.id;

    // A completed search is not rerun, even when asked for by id.
    expect(await batchUc.rerunFailedSearches(f.batchDeps, f.actor, id, [completedId])).toEqual({ rerun: 0 });
    // Two calls at once move each failed search once.
    const both = await Promise.all([batchUc.rerunFailedSearches(f.batchDeps, f.actor, id), batchUc.rerunFailedSearches(f.batchDeps, f.actor, id)]);
    expect(both.map((r) => r.rerun).sort()).toEqual([0, 2]);
    const after = await queries(id);
    expect(after.filter((r) => failedIds.includes(r.id)).map((r) => [r.status, r.rerun_count, r.last_error])).toEqual([
      ["queued", 1, null],
      ["queued", 1, null],
    ]);
    expect(await batchUc.rerunFailedSearches(f.batchDeps, f.actor, id)).toEqual({ rerun: 0 });

    // With the provider back, the rerun finishes them.
    f.gateway.searchBehavior = () => "ok";
    await runAll(f);
    expect((await queries(id)).map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("rejects a batch id of another organization or a malformed id", async () => {
    const f = await fixture();
    const other = await fixture();
    const { id } = await upload(other, [searchUrl(1)]);
    for (const bad of [id, "not-a-uuid"]) {
      await expect(batchUc.getLinkedInSearchBatch(f.batchDeps, f.actor, bad)).rejects.toBeInstanceOf(NotFoundError);
      await expect(batchUc.rerunFailedSearches(f.batchDeps, f.actor, bad)).rejects.toBeInstanceOf(NotFoundError);
      await expect(batchUc.exportSearchBatchResults(f.batchDeps, f.actor, bad).next()).rejects.toBeInstanceOf(NotFoundError);
    }
    expect((await batchUc.listLinkedInSearchBatches(f.batchDeps, f.actor)).batches).toEqual([]);
    expect((await batchUc.listLinkedInSearchBatches(other.batchDeps, other.actor)).batches).toHaveLength(1);
  });

  it("exports the stored results as CSV with formula-safe cells, in pages with no gap or repeat", async () => {
    const f = await fixture({ people: 25 });
    const { id } = await upload(f, [["=SUM(1)", searchUrl(1)], ["Beta, Inc", searchUrl(2)]], { maxResults: 25 });
    await runAll(f);

    const text = (await Array.fromAsync(batchUc.exportSearchBatchResults(f.batchDeps, f.actor, id))).join("");
    expect(text.startsWith("﻿company_name,search_url,profile_url,")).toBe(true);
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(1 + 25 + 25);
    // Two searches finish in either order, so find the rows instead of reading a fixed position.
    const formulaLine = lines.find((l) => l.includes("'=SUM(1)"));
    expect(formulaLine).toBeDefined();
    expect(lines.some((l) => l.startsWith('"Beta, Inc"'))).toBe(true);
    expect(formulaLine!.endsWith(",yes")).toBe(true);

    // Small pages walk the same rows once each.
    const seen: string[] = [];
    for await (const chunk of batchStore.resultPages(f.org, id, 7)) seen.push(...chunk.map((r) => `${r.searchUrl}|${r.profileUrl}`));
    expect(seen).toHaveLength(50);
    expect(new Set(seen).size).toBe(50);
  });

  it("lists a batch's searches in sheet order when every row shares one timestamp", async () => {
    const f = await fixture();
    const { id } = await upload(f, [["First", searchUrl(1)], ["Second", searchUrl(2)], ["Third", searchUrl(3)], ["Fourth", searchUrl(4)]]);
    // One upload inserts its rows in one statement, so they share a timestamp. Ids run against the sheet order.
    await sql`update linkedin_search_queries set created_at = ${start}, id = ${sql`('00000000-0000-4000-8000-00000000000' || (9 - source_row))::uuid`} where batch_id = ${id}`;
    // A search added later has no sheet row and follows the sheet.
    await batchStore.addQueries(f.org, id, [{ url: searchUrl(5), companyName: "Added" }], 1000);

    const detail = await batchStore.get(f.org, id);
    expect(detail?.items.map((i) => [i.sourceRow, i.companyName])).toEqual([
      [2, "First"],
      [3, "Second"],
      [4, "Third"],
      [5, "Fourth"],
      [null, "Added"],
    ]);
  });

  it("keeps a bulk batch's searches off the single-search list and links the batch instead", async () => {
    const f = await fixture();
    const single = await searchStore.create(f.org, { name: "Mine", url: searchUrl("single"), maxResults: 10, campaignId: null });
    const { id } = await upload(f, [searchUrl(1), searchUrl(2), searchUrl(3)], { name: "Sheet" });

    const listed = await searchStore.list(f.org);
    expect(listed.map((s) => s.id)).toEqual([single]);
    expect(await searchStore.listBatches(f.org)).toEqual([{ id, name: "Sheet", searches: 3 }]);
    const other = await fixture();
    expect(await searchStore.list(other.org)).toEqual([]);
    expect(await searchStore.listBatches(other.org)).toEqual([]);
  });

  it("does not let bulk searches push a single search out of the 200 listed", async () => {
    const f = await fixture();
    const single = await searchStore.create(f.org, { name: "Old", url: searchUrl("old"), maxResults: 10, campaignId: null });
    await sql`update linkedin_search_queries set created_at = ${new Date("2020-01-01T00:00:00Z")} where id = ${single}`;
    const { id } = await upload(f, [searchUrl(1)], { name: "Sheet" });
    await sql`
      insert into linkedin_search_queries (organization_id, batch_id, url, status)
      select ${f.org}, ${id}, ${searchUrl("bulk")} || n, 'queued' from generate_series(1, 205) n`;

    expect((await searchStore.list(f.org)).map((s) => s.id)).toEqual([single]);
    expect(await searchStore.listBatches(f.org)).toEqual([{ id, name: "Sheet", searches: 206 }]);
  });
});
