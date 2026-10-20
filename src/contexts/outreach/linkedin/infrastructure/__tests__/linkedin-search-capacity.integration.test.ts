import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { Actor } from "@/shared/errors";
import type { SearchItem, SearchPage } from "../../application/linkedin-ports";
import type { LinkedInSearchBatchDeps, LinkedInSearchEngineDeps } from "../../application/linkedin-search-ports";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

const now = new Date("2026-10-14T10:00:00Z");

describeDb("linkedin search capacity read model", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let capacity: typeof import("../../application/linkedin-search-capacity");
  let capacityStore: typeof import("../drizzle-linkedin-search-capacity").drizzleLinkedInSearchCapacityStore;
  let engine: typeof import("../../application/run-linkedin-search");
  let engineStore: typeof import("../drizzle-linkedin-search-store").drizzleLinkedInSearchEngineStore;
  let batchStore: typeof import("../drizzle-linkedin-search-batch-store").drizzleLinkedInSearchBatchStore;
  let campaignStore: typeof import("../drizzle-linkedin-campaign-store").drizzleLinkedInCampaignStore;
  let batchUc: typeof import("../../application/linkedin-search-batch");
  let sink: typeof import("../search-lead-sink").searchLeadSink;
  const cleanup: string[] = [];
  const users: string[] = [];

  async function fixture(settings?: Record<string, unknown>) {
    await sql`update linkedin_search_queries set status = 'cancelled' where status in ('queued', 'running', 'paused', 'paused_limit')`;
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('C', ${"sc-" + tag}) returning id`;
    cleanup.push(org);
    if (settings) await sql`insert into channel_settings (organization_id, channel, values) values (${org}, 'linkedin', ${sql.json(settings as never)})`;
    const account = async (n: number, status = "connected") => {
      const [{ id }] = await sql`
        insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, name, status, created_at)
        values (${org}, ${`a${n}-${tag}`}, ${`ACo${n}-${tag}`}, ${`user${n}-${tag}`}, ${`Account ${n}`}, ${status}, ${new Date(now.getTime() + n * 1000)}) returning id`;
      return id as string;
    };
    const actor: Actor = { userId: "00000000-0000-4000-8000-000000000000", organizationId: org, role: "member" };
    return { org, tag, account, actor };
  }

  const view = (actor: Actor, accountIds: string[] = []) => capacity.getSearchCapacity({ capacity: capacityStore, now: () => now }, actor, accountIds);

  beforeAll(async () => {
    capacity = await import("../../application/linkedin-search-capacity");
    batchUc = await import("../../application/linkedin-search-batch");
    engine = await import("../../application/run-linkedin-search");
    ({ drizzleLinkedInSearchCapacityStore: capacityStore } = await import("../drizzle-linkedin-search-capacity"));
    ({ drizzleLinkedInSearchEngineStore: engineStore } = await import("../drizzle-linkedin-search-store"));
    ({ drizzleLinkedInSearchBatchStore: batchStore } = await import("../drizzle-linkedin-search-batch-store"));
    ({ drizzleLinkedInCampaignStore: campaignStore } = await import("../drizzle-linkedin-campaign-store"));
    ({ searchLeadSink: sink } = await import("../search-lead-sink"));
  });

  afterAll(async () => {
    await dropOrgs(sql, cleanup.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("lists connected accounts with the organization's daily limit and tiers", async () => {
    const f = await fixture({ searchLeadsPerDay: 100 });
    const fresh = await f.account(1);
    const half = await f.account(2);
    const low = await f.account(3);
    const spent = await f.account(4);
    await f.account(5, "disconnected");
    const day = now.toISOString().slice(0, 10);
    await sql`update linkedin_accounts set search_leads_today = 50, search_day = ${day} where id = ${half}`;
    await sql`update linkedin_accounts set search_leads_today = 90, search_day = ${day} where id = ${low}`;
    await sql`update linkedin_accounts set search_leads_today = 100, search_day = ${day} where id = ${spent}`;

    const out = await view(f.actor);
    expect(out.accounts.map((a) => [a.id, a.limit, a.used, a.left, a.tier])).toEqual([
      [fresh, 100, 0, 100, "green"],
      [half, 100, 50, 50, "yellow"],
      [low, 100, 90, 10, "red"],
      [spent, 100, 100, 0, "red"],
    ]);
    expect(out.nextReturnAt).toBeNull();
    // The daily count restarts at the next UTC midnight, whatever the organization's zone prints.
    expect(out.dayResetsAt).toEqual(new Date("2026-10-15T00:00:00Z"));
  });

  it("uses the default limit without settings, and counts yesterday's usage as zero", async () => {
    const f = await fixture();
    const account = await f.account(1);
    await sql`update linkedin_accounts set search_leads_today = 399, search_day = '2026-10-13' where id = ${account}`;
    const [row] = (await view(f.actor)).accounts;
    expect(row).toMatchObject({ limit: 400, used: 0, left: 400, tier: "green" });
  });

  it("shows when capacity returns once every account is spent or restricted", async () => {
    const f = await fixture({ searchLeadsPerDay: 50 });
    const a = await f.account(1);
    const b = await f.account(2);
    const day = now.toISOString().slice(0, 10);
    await sql`update linkedin_accounts set search_leads_today = 50, search_day = ${day} where id = ${a}`;
    await sql`update linkedin_accounts set search_leads_today = 5, search_day = ${day}, limit_reached_until = ${new Date("2026-10-14T16:00:00Z")} where id = ${b}`;
    const out = await view(f.actor);
    const [first, second] = out.accounts;
    expect(first).toMatchObject({ tier: "red", returnsAt: new Date("2026-10-15T00:00:00Z") });
    expect(second).toMatchObject({ tier: "red", left: 45, restrictedUntil: new Date("2026-10-14T16:00:00Z"), returnsAt: new Date("2026-10-14T16:00:00Z") });
    expect(out.nextReturnAt).toEqual(new Date("2026-10-14T16:00:00Z"));
    expect(out.nextReturnText).toBe("Wed 14 Oct, 16:00 UTC");
  });

  it("narrows to the accounts a batch may use", async () => {
    const f = await fixture();
    const a = await f.account(1);
    await f.account(2);
    expect((await view(f.actor, [a])).accounts.map((x) => x.id)).toEqual([a]);
    expect((await view(f.actor)).accounts).toHaveLength(2);
  });

  it("does not show an account of another organization", async () => {
    const f = await fixture();
    const other = await fixture();
    await other.account(1);
    expect((await view(f.actor)).accounts).toEqual([]);
  });

  it("follows the allowance the engine counts after a page", async () => {
    const f = await fixture({ searchLeadsPerDay: 20 });
    await f.account(1);
    const [{ id: userId }] = await sql`insert into users (name, email) values ('U', ${`u-${f.tag}@cap.test`}) returning id`;
    users.push(userId);
    const actor: Actor = { ...f.actor, userId };
    const items: SearchItem[] = Array.from({ length: 10 }, (_, i) => ({ identifier: `p${i}-${f.tag}`, profileUrl: `https://www.linkedin.com/in/p${i}-${f.tag}`, name: `P${i} Tester`, headline: "h", location: null, networkDistance: null, raw: {} }));
    const gateway = new FakeLinkedInGateway();
    gateway.searchPages = [{ items, nextCursor: "2", totalEstimate: 40 } satisfies SearchPage];
    const deps: LinkedInSearchEngineDeps = { store: engineStore, gateways: gateway, sink, clock: { now: () => now }, random: () => 0 };
    const batchDeps: LinkedInSearchBatchDeps = { batches: batchStore, campaigns: campaignStore };
    await batchUc.uploadLinkedInSearchBatch(batchDeps, actor, { name: "n", headers: ["search_url"], rows: [{ search_url: `https://www.linkedin.com/search/results/people/?keywords=cap${f.tag}` }], maxResults: 40 });
    expect((await engine.runNextSearchPage(deps)).kind).toBe("page");

    const [row] = (await view(actor)).accounts;
    expect(row).toMatchObject({ limit: 20, used: 10, left: 10, tier: "yellow" });
  });
});
