import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import type { LinkedInSearchEngineDeps, LinkedInSearchEngineStore, LinkedInSearchDeps, SearchPageClaim } from "../../application/linkedin-search-ports";
import type { SearchItem, SearchPage } from "../../application/linkedin-ports";
import { LinkedInGatewayError } from "../../application/linkedin-ports";
import { FakeLinkedInGateway } from "../fake-linkedin-gateway";


const SEARCH_URL = "https://www.linkedin.com/search/results/people/?keywords=cto";
const start = new Date("2026-10-14T10:00:00Z");

describeDb("linkedin search queue", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let uc: typeof import("../../application/linkedin-search");
  let engine: typeof import("../../application/run-linkedin-search");
  let engineStore: typeof import("../drizzle-linkedin-search-store").drizzleLinkedInSearchEngineStore;
  let searchStore: typeof import("../drizzle-linkedin-search-store").drizzleLinkedInSearchStore;
  let campaignStore: typeof import("../drizzle-linkedin-campaign-store").drizzleLinkedInCampaignStore;
  let sink: typeof import("../search-lead-sink").searchLeadSink;
  let jobs: typeof import("../../application/linkedin-jobs");
  const cleanup: string[] = [];

  let current = start;
  const clock = { now: () => current };
  const advance = (seconds: number) => {
    current = new Date(current.getTime() + seconds * 1000);
  };

  /** A search result page set: `count` people over pages of `size`, cursors "1", "2", ... and a null cursor on the last page. */
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

  async function fixture(options: { accounts?: number; people?: number; settings?: Record<string, unknown> } = {}) {
    current = start;
    // The claim looks across organizations, so searches left by earlier tests must not be due.
    await sql`update linkedin_search_queries set status = 'cancelled' where status in ('queued', 'running', 'paused', 'paused_limit')`;
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('S', ${"ls-" + tag}) returning id`;
    cleanup.push(org);
    const accounts: Array<{ id: string; ref: string }> = [];
    for (let i = 0; i < (options.accounts ?? 1); i++) {
      const [{ id }] = await sql`
        insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, name, status, created_at)
        values (${org}, ${`acct${i}-${tag}`}, ${`ACo${i}-${tag}`}, ${`owner${i}-${tag}`}, ${`Owner ${i}`}, 'connected', ${new Date(start.getTime() + i * 1000)}) returning id`;
      accounts.push({ id, ref: `acct${i}-${tag}` });
    }
    if (options.settings) await sql`insert into channel_settings (organization_id, channel, values) values (${org}, 'linkedin', ${sql.json(options.settings as never)})`;
    const gateway = new FakeLinkedInGateway();
    gateway.searchPages = pages(tag, options.people ?? 25);
    const deps: LinkedInSearchEngineDeps = { store: engineStore, gateways: gateway, sink, clock, random: () => 0 };
    const searchDeps: LinkedInSearchDeps = { searches: searchStore, campaigns: campaignStore };
    const actor: Actor = { userId: "00000000-0000-0000-0000-000000000000", organizationId: org, role: "owner" };
    return { org, tag, accounts, gateway, deps, searchDeps, actor };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const create = async (f: Fixture, input: Partial<Parameters<typeof uc.createLinkedInSearch>[2]> = {}) =>
    (await uc.createLinkedInSearch(f.searchDeps, f.actor, { name: "CTOs", url: SEARCH_URL, ...input })).id;
  const row = async (id: string) => (await sql`select * from linkedin_search_queries where id = ${id}`)[0];
  /** Every stored result row points at a lead of the same organization, and that lead's URL is empty or the provider URL. */
  const expectResultsLinkToPeople = async (queryId: string, expected: number, unlinked = 0) => {
    const rows = await sql`
      select r.profile_url, r.person_id, p.id as found_id, p.organization_id as person_org, r.organization_id as result_org, p.linkedin_url
      from linkedin_search_results r left join people p on p.id = r.person_id where r.query_id = ${queryId}`;
    expect(rows).toHaveLength(expected + unlinked);
    expect(rows.filter((r) => r.person_id === null)).toHaveLength(unlinked);
    for (const r of rows.filter((r) => r.person_id !== null)) {
      expect(r.person_id).not.toBeNull();
      expect(r.found_id).toBe(r.person_id);
      expect(r.person_org).toBe(r.result_org);
      expect([null, r.profile_url, r.profile_url.replace(/\/?$/, "/")], JSON.stringify(r)).toContain(r.linkedin_url);
    }
    expect(new Set(rows.filter((r) => r.person_id !== null).map((r) => r.person_id)).size).toBe(expected);
  };
  const peopleOf = async (org: string) => await sql`select * from people where organization_id = ${org} order by linkedin_slug`;
  /** One page, then the pacing gap passes. */
  const page = async (f: Fixture, deps = f.deps) => {
    const outcome = await engine.runNextSearchPage(deps);
    advance(10);
    return outcome;
  };
  const runAll = async (f: Fixture, max = 20) => {
    for (let i = 0; i < max; i++) if ((await page(f)).kind === "idle") return;
  };

  beforeAll(async () => {
    uc = await import("../../application/linkedin-search");
    engine = await import("../../application/run-linkedin-search");
    jobs = await import("../../application/linkedin-jobs");
    ({ drizzleLinkedInSearchEngineStore: engineStore, drizzleLinkedInSearchStore: searchStore } = await import("../drizzle-linkedin-search-store"));
    ({ drizzleLinkedInCampaignStore: campaignStore } = await import("../drizzle-linkedin-campaign-store"));
    ({ searchLeadSink: sink } = await import("../search-lead-sink"));
  });

  afterAll(async () => {
    await dropOrgs(sql, cleanup.map((organizationId) => ({ organizationId })));
    await sql.end();
  });

  it("pages through results, stores a lead per person and finishes at the last page", async () => {
    const f = await fixture();
    const id = await create(f);

    expect(await page(f)).toMatchObject({ kind: "page", kept: 10, done: false });
    expect(await row(id)).toMatchObject({ status: "running", cursor: "1", leads_fetched: 10, imported_count: 10, pages_fetched: 1, total_count: 25 });
    expect(await page(f)).toMatchObject({ kind: "page", kept: 10 });
    expect(await page(f)).toMatchObject({ kind: "page", kept: 5, done: true });

    const done = await row(id);
    expect(done).toMatchObject({ status: "completed", cursor: null, leads_fetched: 25, imported_count: 25, pages_fetched: 3 });
    expect(done.completed_at).not.toBeNull();
    expect(f.gateway.searchLog.map((c) => c.cursor)).toEqual([null, "1", "2"]);
    expect(new Set(f.gateway.searchLog.map((c) => c.account))).toEqual(new Set([f.accounts[0].ref]));

    const people = await peopleOf(f.org);
    expect(people).toHaveLength(25);
    expect(people[0]).toMatchObject({ first_name: expect.stringMatching(/^Person/), last_name: "Tester", source: `linkedin_search:${id}` });
    await expectResultsLinkToPeople(id, 25);
    expect((await page(f)).kind).toBe("idle");
  });

  it("waits out the pacing gap between pages and gives the account to one search at a time", async () => {
    const f = await fixture();
    await create(f);
    await create(f, { name: "Second" });
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("page");
    // The account holds a gap of 3 seconds, and the first search is not due either.
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
    advance(4);
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("page");
  });

  it("claims one account for one search even when two workers ask at once", async () => {
    const f = await fixture();
    await create(f);
    await create(f, { name: "Second" });
    const claims = await Promise.all([engineStore.claimPage({ now: current, random: () => 0 }), engineStore.claimPage({ now: current, random: () => 0 })]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("never overwrites stored fields and does not create a second lead for a known profile", async () => {
    const f = await fixture({ people: 3 });
    const slug = `p1-${f.tag}`;
    await sql`insert into people (organization_id, linkedin_slug, first_name, title, source) values (${f.org}, ${slug}, 'Janet', 'Founder', 'manual')`;
    const id = await create(f);
    await runAll(f);

    const people = await peopleOf(f.org);
    expect(people).toHaveLength(3);
    const known = people.find((p) => p.linkedin_slug === slug);
    expect(known).toMatchObject({ first_name: "Janet", title: "Founder", source: "manual", last_name: "Tester", full_name: "Person1 Tester" });
    expect(await row(id)).toMatchObject({ status: "completed", leads_fetched: 3, imported_count: 3 });

    // The same search again finds the same people: no new leads.
    const again = await create(f, { name: "Again" });
    await runAll(f);
    expect(await peopleOf(f.org)).toHaveLength(3);
    expect(await row(again)).toMatchObject({ status: "completed", leads_fetched: 3 });
  });

  it("stops at the result cap and does not read further pages", async () => {
    const f = await fixture();
    const id = await create(f, { maxResults: 15 });
    await runAll(f);
    expect(await row(id)).toMatchObject({ status: "completed", leads_fetched: 15, cursor: null });
    expect(f.gateway.searchLog).toHaveLength(2);
    expect(await peopleOf(f.org)).toHaveLength(15);
  });

  it("keeps a lead for a result with only a member id and none for a result with no profile at all", async () => {
    const f = await fixture({ people: 0 });
    f.gateway.searchPages = [
      {
        items: [
          { identifier: "ACwAAAopaque1xxxxxxxxxxxxxxxxxxxxxxx", profileUrl: null, name: "Hidden One", headline: null, location: null, networkDistance: null, raw: {} },
          { identifier: `ok-${f.tag}`, profileUrl: `https://www.linkedin.com/in/ok-${f.tag}`, name: "Visible Two", headline: null, location: null, networkDistance: null, raw: {} },
          { identifier: "not a profile", profileUrl: "https://www.linkedin.com/company/acme", name: "Acme", headline: null, location: null, networkDistance: null, raw: {} },
        ],
        nextCursor: null,
        totalEstimate: 3,
      },
    ];
    const id = await create(f);
    await runAll(f);
    expect(await row(id)).toMatchObject({ status: "completed", leads_fetched: 3, imported_count: 2 });
    expect(await peopleOf(f.org)).toHaveLength(2);
    const [hidden] = await sql`select linkedin_slug, raw from people where organization_id = ${f.org} and linkedin_slug is null`;
    expect(hidden).toMatchObject({ linkedin_slug: null, raw: { linkedin_member_id: "ACwAAAopaque1xxxxxxxxxxxxxxxxxxxxxxx" } });
    await expectResultsLinkToPeople(id, 2, 1);
  });

  it("rolls back the page and resumes from the stored cursor after a crash between the lead import and the page write", async () => {
    const f = await fixture();
    const id = await create(f);
    await page(f);
    expect((await row(id)).cursor).toBe("1");

    // Crash: the process dies while the page is recorded. The leads of page 2 were created in the same transaction, so they roll back.
    let crashed = false;
    const crashing: LinkedInSearchEngineStore = {
      ...engineStore,
      recordPage: (claim, recorded, now, gap) =>
        engineStore.recordPage(
          claim,
          {
            ...recorded,
            results: async (tx) => {
              await recorded.results(tx);
              crashed = true;
              throw new Error("process died");
            },
          },
          now,
          gap,
        ),
    };
    await expect(engine.runNextSearchPage({ ...f.deps, store: crashing })).rejects.toThrow("process died");
    expect(crashed).toBe(true);
    expect(await row(id)).toMatchObject({ cursor: "1", leads_fetched: 10 });
    expect(await peopleOf(f.org)).toHaveLength(10);

    // The lease holds the search for two minutes, then another worker takes the same cursor.
    advance(30);
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
    advance(120);
    expect(await page(f)).toMatchObject({ kind: "page", kept: 10 });
    expect(await row(id)).toMatchObject({ cursor: "2", leads_fetched: 20 });
    await runAll(f);
    expect(await row(id)).toMatchObject({ status: "completed", leads_fetched: 25 });
    expect(await peopleOf(f.org)).toHaveLength(25);
    expect(f.gateway.searchLog.map((c) => c.cursor)).toEqual([null, "1", "1", "2"]);
  });

  it("retries an unknown outcome on the same cursor with a backoff, and fails after five", async () => {
    const f = await fixture();
    const id = await create(f);
    f.gateway.searchBehavior = () => "timeout-lost";
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("retry");
    expect(await row(id)).toMatchObject({ failures: 1, cursor: null, status: "running" });
    expect((await row(id)).last_error).toMatch(/timed out/);

    // Not due before the one-minute backoff.
    advance(30);
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
    advance(40);
    f.gateway.searchBehavior = () => "ok";
    expect(await page(f)).toMatchObject({ kind: "page" });
    expect(await row(id)).toMatchObject({ failures: 0, last_error: null });

    f.gateway.searchBehavior = () => "timeout-after-accept";
    for (let i = 0; i < 5; i++) {
      advance(16 * 60);
      await engine.runNextSearchPage(f.deps);
    }
    const failed = await row(id);
    expect(failed.status).toBe("failed");
    expect(failed.last_error).toMatch(/gave up after 5 tries/);
    expect(failed.cursor).toBe("1");

    // Retrying from the failed state continues at the stored cursor.
    f.gateway.searchBehavior = () => "ok";
    await uc.changeLinkedInSearch(f.searchDeps, f.actor, id, "resume");
    await runAll(f);
    expect(await row(id)).toMatchObject({ status: "completed", leads_fetched: 25 });
  });

  it("fails on a definite refusal and records why", async () => {
    const f = await fixture();
    const id = await create(f);
    f.gateway.searchBehavior = () => ({ refuse: "rejected" });
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("failed");
    expect(await row(id)).toMatchObject({ status: "failed", last_error: "Fake refusal: rejected" });
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
  });

  it("fails a search on insufficient_privileges without retrying and without disconnecting the account", async () => {
    const f = await fixture();
    const id = await create(f);
    f.gateway.searchBehavior = () => ({ refuse: "insufficient_privileges" });
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("failed");
    expect(await row(id)).toMatchObject({ status: "failed", last_error: "Fake refusal: insufficient_privileges" });
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
    expect(f.gateway.searchLog).toHaveLength(1);
    expect((await sql`select status from linkedin_accounts where organization_id = ${f.org}`).map((a) => a.status)).toEqual(["connected"]);
  });

  it("pauses the account on a rate limit and restarts the search on another account from page 1", async () => {
    const f = await fixture({ accounts: 2 });
    const id = await create(f);
    await page(f);
    const first = await row(id);
    expect(first.cursor).toBe("1");

    // The account that holds the cursor is limited on the next page.
    const holder = f.accounts.find((a) => a.id === first.current_account_id);
    f.gateway.searchBehavior = (call) => (call.account === holder?.ref ? { refuse: "rate_limited" } : "ok");
    expect((await page(f)).kind).toBe("paused");
    const [limited] = await sql`select limit_reached_until, search_lease_until from linkedin_accounts where id = ${holder?.id as string}`;
    expect(limited.limit_reached_until.getTime()).toBe(current.getTime() - 10_000 + 24 * 3_600_000);
    expect(await row(id)).toMatchObject({ cursor: null, current_account_id: null, status: "running" });

    await runAll(f);
    const done = await row(id);
    expect(done).toMatchObject({ status: "completed", leads_fetched: 25 });
    expect(done.current_account_id).not.toBe(holder?.id);
    expect(await peopleOf(f.org)).toHaveLength(25);
    // Page 1 was read again on the other account, and added nothing twice.
    expect(f.gateway.searchLog.filter((c) => c.cursor === null)).toHaveLength(2);
  });

  it("leaves the search waiting when the only account is limited, and resumes when the pause ends", async () => {
    const f = await fixture();
    const id = await create(f);
    f.gateway.searchBehavior = () => ({ refuse: "rate_limited" });
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("paused");
    f.gateway.searchBehavior = () => "ok";
    advance(3600);
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
    advance(24 * 3600);
    await runAll(f);
    expect(await row(id)).toMatchObject({ status: "completed", leads_fetched: 25 });
  });

  it("marks an account disconnected on an auth refusal and moves the search to another", async () => {
    const f = await fixture({ accounts: 2 });
    const id = await create(f);
    // The first account that is asked rejects its credentials. The other one works.
    let rejected: string | null = null;
    f.gateway.searchBehavior = (call) => {
      rejected ??= call.account;
      return call.account === rejected ? { refuse: "auth" } : "ok";
    };
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("paused");
    const statuses = await sql`select status from linkedin_accounts where organization_id = ${f.org}`;
    expect(statuses.filter((s) => s.status === "disconnected")).toHaveLength(1);
    f.gateway.searchBehavior = () => "ok";
    await runAll(f);
    expect(await row(id)).toMatchObject({ status: "completed", leads_fetched: 25 });
  });

  it("respects the daily search allowance per account and continues the next day", async () => {
    const f = await fixture({ settings: { searchLeadsPerDay: 10 } });
    const id = await create(f);
    expect(await page(f)).toMatchObject({ kind: "page" });
    const [account] = await sql`select search_leads_today, search_day from linkedin_accounts where id = ${f.accounts[0].id}`;
    expect(account).toMatchObject({ search_leads_today: 10, search_day: "2026-10-14" });

    expect((await page(f)).kind).toBe("idle");
    expect(await row(id)).toMatchObject({ status: "paused_limit", cursor: "1" });
    expect((await row(id)).last_error).toMatch(/daily search allowance/);

    advance(24 * 3600);
    expect(await page(f)).toMatchObject({ kind: "page" });
    // The cursor survived the wait, so page 1 was not read again.
    expect(f.gateway.searchLog.map((c) => c.cursor)).toEqual([null, "1"]);
    expect(await row(id)).toMatchObject({ status: "running", cursor: "2", leads_fetched: 20 });
  });

  it("moves a search to a second account when the first one used its allowance", async () => {
    const f = await fixture({ accounts: 2, settings: { searchLeadsPerDay: 10 } });
    const id = await create(f);
    await page(f);
    const holder = (await row(id)).current_account_id;
    expect(await page(f)).toMatchObject({ kind: "page" });
    expect((await row(id)).current_account_id).not.toBe(holder);
    // The new account started over at page 1.
    expect(f.gateway.searchLog.map((c) => c.cursor)).toEqual([null, null]);
    expect(await row(id)).toMatchObject({ leads_fetched: 10, cursor: "1" });
  });

  it("pauses, resumes and cancels, and refuses moves the status does not allow", async () => {
    const f = await fixture();
    const id = await create(f);
    expect(await uc.changeLinkedInSearch(f.searchDeps, f.actor, id, "pause")).toEqual({ status: "paused" });
    await expect(uc.changeLinkedInSearch(f.searchDeps, f.actor, id, "pause")).rejects.toBeInstanceOf(ConflictError);
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
    expect(f.gateway.searchLog).toHaveLength(0);

    await page(f);
    await uc.changeLinkedInSearch(f.searchDeps, f.actor, id, "resume");
    expect(await page(f)).toMatchObject({ kind: "page" });
    expect(await row(id)).toMatchObject({ cursor: "1", leads_fetched: 10 });

    expect(await uc.changeLinkedInSearch(f.searchDeps, f.actor, id, "cancel")).toEqual({ status: "cancelled" });
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
    await expect(uc.changeLinkedInSearch(f.searchDeps, f.actor, id, "resume")).rejects.toBeInstanceOf(ConflictError);
    // People found before the cancel stay.
    expect(await peopleOf(f.org)).toHaveLength(10);
  });

  it("drops a page when the search is cancelled while the provider call runs", async () => {
    const f = await fixture();
    const id = await create(f);
    f.gateway.onSearch = async () => {
      await uc.changeLinkedInSearch(f.searchDeps, f.actor, id, "cancel");
    };
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("dropped");
    expect(await row(id)).toMatchObject({ status: "cancelled", leads_fetched: 0, pages_fetched: 0 });
    expect(await peopleOf(f.org)).toHaveLength(0);
    // The account still counts the people it read.
    const [account] = await sql`select search_leads_today from linkedin_accounts where id = ${f.accounts[0].id}`;
    expect(account.search_leads_today).toBe(10);
  });

  it("keeps the page when the search is paused while the provider call runs", async () => {
    const f = await fixture();
    const id = await create(f);
    f.gateway.onSearch = async () => {
      await uc.changeLinkedInSearch(f.searchDeps, f.actor, id, "pause");
    };
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("page");
    expect(await row(id)).toMatchObject({ status: "paused", leads_fetched: 10, cursor: "1" });
    f.gateway.onSearch = null;
    advance(60);
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
  });

  describe("atomic page", () => {
    /** Makes the next insert into `table` fail, so the page breaks right after the step before it. */
    async function failingInsertInto<T>(table: string, run: () => Promise<T>) {
      await sql.unsafe(`create or replace function search_test_block_insert() returns trigger language plpgsql as $$ begin raise exception 'blocked ${table}'; end $$`);
      await sql.unsafe(`create trigger search_test_block_insert before insert on ${table} for each row execute function search_test_block_insert()`);
      try {
        return await run();
      } finally {
        await sql.unsafe(`drop trigger search_test_block_insert on ${table}`);
        await sql.unsafe(`drop function search_test_block_insert()`);
      }
    }

    for (const table of ["people", "campaign_enrollments", "linkedin_search_results"]) {
      it(`leaves no lead, enrollment or progress when the page fails at ${table}`, async () => {
        const f = await fixture({ people: 5 });
        const [{ id: campaign }] = await sql`
          insert into campaigns (organization_id, channel, name, status, steps)
          values (${f.org}, 'linkedin', 'Outreach', 'draft', ${sql.json([{ stepNumber: 1, kind: "invitation", body: "Hi", waitDays: 0 }] as never)}) returning id`;
        const id = await create(f, { campaignId: campaign });
        await expect(failingInsertInto(table, () => engine.runNextSearchPage(f.deps))).rejects.toThrow();
        expect(await peopleOf(f.org)).toHaveLength(0);
        expect(await sql`select 1 from campaign_enrollments where campaign_id = ${campaign}`).toHaveLength(0);
        expect(await sql`select 1 from linkedin_search_results where query_id = ${id}`).toHaveLength(0);
        expect(await row(id)).toMatchObject({ leads_fetched: 0, imported_count: 0, pages_fetched: 0, cursor: null });

        // After the lease expires the same page is read again and stores everything once.
        advance(180);
        expect(await page(f)).toMatchObject({ kind: "page", kept: 5 });
        expect(await peopleOf(f.org)).toHaveLength(5);
        expect(await sql`select 1 from campaign_enrollments where campaign_id = ${campaign}`).toHaveLength(5);
        expect(await row(id)).toMatchObject({ leads_fetched: 5, imported_count: 5 });
      });
    }

    it("creates no lead when the search was cancelled during the provider call", async () => {
      const f = await fixture({ people: 5 });
      const id = await create(f);
      const cancelling: LinkedInSearchEngineStore = {
        ...engineStore,
        recordPage: async (claim, recorded, now, gap) => {
          await sql`update linkedin_search_queries set status = 'cancelled' where id = ${id}`;
          return engineStore.recordPage(claim, recorded, now, gap);
        },
      };
      expect((await engine.runNextSearchPage({ ...f.deps, store: cancelling })).kind).toBe("dropped");
      expect(await peopleOf(f.org)).toHaveLength(0);
    });
  });

  it("enrolls found people into the target campaign once, and skips do-not-contact", async () => {
    const f = await fixture({ people: 5 });
    const [{ id: campaign }] = await sql`
      insert into campaigns (organization_id, channel, name, status, steps)
      values (${f.org}, 'linkedin', 'Outreach', 'draft', ${sql.json([{ stepNumber: 1, kind: "invitation", body: "Hi", waitDays: 0 }] as never)}) returning id`;
    const [{ id: blocked }] = await sql`insert into people (organization_id, linkedin_slug) values (${f.org}, ${"p2-" + f.tag}) returning id`;
    await sql`insert into contact_policies (organization_id, person_id, do_not_contact, reason, source, set_at) values (${f.org}, ${blocked}, true, 'asked', 'human', now())`;

    const id = await create(f, { campaignId: campaign });
    await runAll(f);
    const enrollments = await sql`
      select e.person_id, d.profile_url from campaign_enrollments e join linkedin_enrollment_details d on d.enrollment_id = e.id where e.campaign_id = ${campaign}`;
    expect(enrollments).toHaveLength(4);
    expect(enrollments.map((e) => e.person_id)).not.toContain(blocked);
    expect(enrollments[0].profile_url).toMatch(/^https:\/\/www\.linkedin\.com\/in\/p/);

    // The same people found again are not enrolled twice.
    await create(f, { name: "Again", campaignId: campaign });
    await runAll(f);
    expect(await sql`select 1 from campaign_enrollments where campaign_id = ${campaign}`).toHaveLength(4);
    expect((await uc.getLinkedInSearch(f.searchDeps, f.actor, id)).targetCampaign).toMatchObject({ id: campaign, name: "Outreach" });
  });

  it("keeps a found contact as a search result, does not enroll it, and reports it in the page stats", async () => {
    const f = await fixture({ people: 5 });
    const [{ id: campaign }] = await sql`
      insert into campaigns (organization_id, channel, name, status, steps)
      values (${f.org}, 'linkedin', 'Outreach', 'draft', ${sql.json([{ stepNumber: 1, kind: "invitation", body: "Hi", waitDays: 0 }] as never)}) returning id`;
    const [{ id: contact }] = await sql`insert into people (organization_id, linkedin_slug, lifecycle, converted_at) values (${f.org}, ${"p1-" + f.tag}, 'contact', now()) returning id`;

    const id = await create(f, { campaignId: campaign });
    expect(await page(f)).toMatchObject({ kind: "page", kept: 5, skippedContact: 1 });
    const enrollments = await sql`select person_id from campaign_enrollments where campaign_id = ${campaign}`;
    expect(enrollments).toHaveLength(4);
    expect(enrollments.map((e) => e.person_id)).not.toContain(contact);
    // The contact is still one of the search's results and counts as imported.
    expect(await row(id)).toMatchObject({ leads_fetched: 5, imported_count: 5 });
    expect((await sql`select person_id from linkedin_search_results where query_id = ${id} and person_id = ${contact}`)).toHaveLength(1);
    expect((await sql`select lifecycle from people where id = ${contact}`)[0].lifecycle).toBe("contact");
  });

  it("validates input and hides other organizations", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(create(f, { name: " " })).rejects.toBeInstanceOf(ValidationError);
    await expect(create(f, { url: "https://www.linkedin.com/in/someone" })).rejects.toBeInstanceOf(ValidationError);
    await expect(create(f, { maxResults: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(create(f, { maxResults: 5000 })).rejects.toBeInstanceOf(ValidationError);
    await expect(create(f, { campaignId: "00000000-0000-4000-8000-000000000000" })).rejects.toBeInstanceOf(NotFoundError);

    const [{ id: foreign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${other.org}, 'linkedin', 'x', 'draft', '[]') returning id`;
    await expect(create(f, { campaignId: foreign })).rejects.toBeInstanceOf(NotFoundError);

    const mine = await create(f);
    await expect(uc.getLinkedInSearch(other.searchDeps, other.actor, mine)).rejects.toBeInstanceOf(NotFoundError);
    await expect(uc.changeLinkedInSearch(other.searchDeps, other.actor, mine, "cancel")).rejects.toBeInstanceOf(NotFoundError);
    expect((await uc.listLinkedInSearches(other.searchDeps, other.actor)).searches).toHaveLength(0);
    expect((await uc.listLinkedInSearches(f.searchDeps, f.actor)).searches).toMatchObject([{ id: mine, status: "queued", url: SEARCH_URL, maxResults: 100 }]);
    expect((await row(mine)).status).toBe("queued");
  });

  it("does not read for an organization without a LinkedIn gateway, and tries again later", async () => {
    const f = await fixture();
    const id = await create(f);
    const none = { ...f.deps, gateways: { forOrganization: async () => null } };
    expect(await engine.runNextSearchPage(none)).toEqual({ kind: "paused", reason: "no_gateway" });
    expect((await row(id)).last_error).toMatch(/not connected/);
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
    advance(6 * 60);
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("page");
  });

  it("waits with a message when no account is connected", async () => {
    const f = await fixture({ accounts: 0 });
    const id = await create(f);
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("idle");
    expect((await row(id)).last_error).toBe("No LinkedIn account is connected.");
  });

  it("runs as a job and stops when no search is due", async () => {
    const f = await fixture();
    await create(f);
    const job = jobs.createLinkedInJobs({ store: {} as never, gateways: f.gateway, clock, random: () => 0 }, {} as never, f.deps, {} as never).find((j) => j.name === "linkedin.search");
    const result = await job?.run({ deadline: Date.now() + 5000, now: () => current });
    // One page per claim: the pacing gap stops a second page in the same tick.
    expect(result).toMatchObject({ processed: 1, more: false, detail: { page: 1 } });
  });

  it("surfaces a gateway error type the engine does not know as an unknown outcome", async () => {
    const f = await fixture();
    const id = await create(f);
    f.gateway.searchBehavior = () => {
      throw new Error("socket hang up");
    };
    expect((await engine.runNextSearchPage(f.deps)).kind).toBe("retry");
    expect((await row(id)).last_error).toBe("socket hang up");
    expect(new LinkedInGatewayError("x", "unknown", "unavailable").kind).toBe("unknown");
  });
});

export type { SearchPageClaim };
