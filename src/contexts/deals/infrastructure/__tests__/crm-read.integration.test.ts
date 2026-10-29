import { readFileSync } from "node:fs";
import path from "node:path";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@/shared/errors";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";
import { bootDealsKit, type DealsKit, type DealsOrg } from "../../../../test-support/deals-test-kit";

/**
 * crm-read, the explicit read model of the CRM screens: the columns it reads are pinned here, nothing writes through
 * it, and its reads return the pinned fields. Also the board (per-stage limit, cursor, totals per currency, owner and search
 * filters, the 30-day window for Won and Lost with an injected clock), the Contacts list (latest deal, owner and stage
 * filters, do not contact) and the Companies list (last activity, open amounts per currency).
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */

const SOURCE = readFileSync(path.join(__dirname, "..", "crm-read.ts"), "utf8");
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Alias in crm-read.ts to the table it names. */
const ALIASES: Record<string, string> = {
  p: "people",
  c: "companies",
  cda: "company_domain_aliases",
  ec: "entity_columns",
  d: "deals",
  s: "deal_stages",
  col: "deal_stages",
  e: "events",
  vc: "conversations",
  vc2: "conversations",
  cp: "contact_policies",
};

/** Every column crm-read reads. A change to one of these columns has to come through this list. */
const PINNED: Record<string, string[]> = {
  people: ["company_id", "converted_at", "custom", "email", "full_name", "id", "lifecycle", "linkedin_slug", "linkedin_url", "organization_id", "phone", "title"],
  companies: ["created_at", "crm_listed_at", "custom", "domain", "id", "linkedin_url", "name", "organization_id", "version"],
  company_domain_aliases: ["company_id", "created_at", "domain", "merged_name", "organization_id"],
  entity_columns: ["archived_at", "entity", "key", "name", "organization_id", "position"],
  deals: [
    "amount_minor", "closed_at", "created_at", "created_by", "currency", "expected_close_on", "id", "lost_reason", "organization_id", "owner_user_id",
    "person_id", "source_enrollment_id", "stage_changed_at", "stage_id", "stage_kind", "title", "updated_at", "version",
  ],
  deal_stages: ["id", "kind", "name", "organization_id", "position"],
  events: ["created_at", "organization_id", "person_id", "record_id"],
  // The private-thread column comes from `publicConversationText`, the one owner of that rule.
  conversations: ["record_id"],
  contact_policies: ["do_not_contact", "organization_id", "person_id"],
};

describe("crm-read source", () => {
  it("reads only the pinned columns of the tables its header lists", () => {
    const read: Record<string, Set<string>> = {};
    for (const match of CODE.matchAll(/\b([a-z][a-z0-9]*)\.([a-z_]+)\b/g)) {
      const table = ALIASES[match[1]];
      if (!table) continue;
      (read[table] ??= new Set()).add(match[2]);
    }
    expect(Object.fromEntries(Object.entries(read).map(([t, cols]) => [t, [...cols].sort()]))).toEqual(PINNED);
    const tables = new Set([...CODE.matchAll(/\b(?:from|join)\s+([a-z_]+)\b/g)].map((m) => m[1]));
    for (const cte of ["contact_counts", "open_counts", "lateral"]) tables.delete(cte);
    expect([...tables].sort()).toEqual(["companies", "company_domain_aliases", "contact_policies", "conversations", "deal_stages", "deals", "entity_columns", "events", "people"]);
    for (const table of Object.keys(PINNED)) expect(SOURCE.split("*/")[0], `header lists ${table}`).toContain(`${table} `);
  });

  it("writes nothing", () => {
    expect(CODE).not.toMatch(/\b(insert|update|delete|truncate|merge)\b/i);
    expect(CODE).not.toMatch(/\.(insert|update|delete)\(/);
  });
});

describeDb("crm-read against Postgres", () => {
  let kit: DealsKit;
  let deals: typeof import("../../application/deals");
  let composition: typeof import("@/composition/deals");
  let crm: typeof import("../crm-read");

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    deals = await import("../../application/deals");
    composition = await import("@/composition/deals");
    crm = await import("../crm-read");
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  it("the pinned columns exist", async () => {
    for (const [table, columns] of Object.entries(PINNED)) {
      const rows = await kit.sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`;
      const present = new Set(rows.map((r) => r.column_name as string));
      expect(columns.filter((c) => !present.has(c)), table).toEqual([]);
    }
  });

  const create = (f: DealsOrg, personId: string, input: Parameters<typeof deals.createDealFromLead>[3] = {}) => deals.createDealFromLead(composition.dealsDeps(), f.owner, personId, input);

  describe("returns the fields the screens use and nothing else", () => {
    let f: DealsOrg;
    let acme: string;
    let personId: string;
    let dealId: string;
    beforeAll(async () => {
      f = await kit.organization();
      acme = await f.company("Acme");
      personId = await f.person({ name: "Ada", companyId: acme });
      ({ dealId } = await create(f, personId, { amount: "10", currency: "USD" }));
    });

    it("a board column and its cards", async () => {
      const stages = await composition.dealsDeps().store.listStages(f.org);
      const [column] = await crm.crmRead.board(f.org, { stageIds: [stages[0].id], limit: 5, closedSince: null });
      expect(Object.keys(column).sort()).toEqual(["amounts", "cards", "nextCursor", "stageId", "total"]);
      expect(Object.keys(column.cards[0]).sort()).toEqual(["amountMinor", "closedAt", "companyName", "currency", "expectedCloseOn", "id", "ownerUserId", "personId", "personName", "sourceEnrollmentId", "stageChangedAt", "title", "version"]);
    });

    it("a deal", async () => {
      expect(Object.keys((await crm.crmRead.deal(f.org, dealId))!).sort()).toEqual([
        "amountMinor", "closedAt", "createdAt", "createdBy", "currency", "expectedCloseOn", "id", "lostReason", "ownerUserId", "personId", "sourceEnrollmentId",
        "stageChangedAt", "stageId", "stageKind", "stageName", "stagePosition", "title", "updatedAt", "version",
      ]);
    });

    it("a Contacts row and its latest deal", async () => {
      const contacts = await crm.crmRead.contacts(f.org, { sort: "converted", page: 1, pageSize: 25 });
      expect(Object.keys(contacts.rows[0]).sort()).toEqual(["companyId", "companyName", "convertedAt", "doNotContact", "email", "id", "lastActivityAt", "latestDeal", "linkedinSlug", "linkedinUrl", "name", "openDeals", "title"]);
      expect(Object.keys(contacts.rows[0].latestDeal!).sort()).toEqual(["id", "ownerUserId", "stageId", "stageKind", "stageName"]);
    });

    it("a Companies row and the company page", async () => {
      const companies = await crm.crmRead.companies(f.org, { sort: "name", page: 1, pageSize: 25 });
      expect(Object.keys(companies.rows[0]).sort()).toEqual(["contacts", "domain", "id", "lastActivityAt", "linkedinUrl", "name", "openAmounts", "openDeals"]);
      expect(Object.keys((await crm.crmRead.company(f.org, acme))!).sort()).toEqual(["aliases", "contacts", "createdAt", "crmListedAt", "custom", "domain", "id", "leads", "linkedinUrl", "name", "version"]);
    });

    it("the deals of a person", async () => {
      expect(Object.keys((await crm.crmRead.dealsOfPeople(f.org, [personId]))[0]).sort()).toEqual(["amountMinor", "closedAt", "createdAt", "currency", "id", "personId", "stageChangedAt", "stageId", "stageKind", "stageName", "title"]);
    });
  });

  it("plans the Contacts list on the partial contacts index even under a generic plan", async () => {
    // A bound `lifecycle = $n` cannot match the partial index people_org_contacts_idx in a generic plan; the literal can.
    const f = await kit.organization();
    // A realistic spread: many leads and some contacts. With a handful of rows any index of the organization costs the
    // same, and the planner's pick says nothing about the partial index.
    await kit.sql`
      insert into people (organization_id, full_name, lifecycle, converted_at)
      select ${f.org}, 'Plan ' || g, case when g % 20 = 0 then 'contact' else 'lead' end, case when g % 20 = 0 then now() end
      from generate_series(1, 2000) g`;
    await crm.crmRead.contacts(f.org, { sort: "converted", page: 1, pageSize: 25 });
    const instance = (globalThis as unknown as { __miasdrDb: { execute: (query: SQL) => Promise<unknown> } }).__miasdrDb;
    const execute = vi.spyOn(instance, "execute");
    let statement: SQL;
    try {
      await crm.crmRead.contacts(f.org, { sort: "converted", page: 1, pageSize: 25 });
      statement = execute.mock.calls[0][0];
    } finally {
      execute.mockRestore();
    }
    const list = new PgDialect().sqlToQuery(statement);
    expect(list.sql).toContain("lifecycle = 'contact'");
    // Other suites fill and empty people; fresh statistics keep the planner's pick about the predicate, not the churn.
    const plan = await kit.sql.begin(async (tx) => {
      await tx`analyze people`;
      await tx`set local enable_seqscan = off`;
      // Bitmap scans go too: the question is whether the partial index can serve the list, not which scan wins on few rows.
      await tx`set local enable_bitmapscan = off`;
      return tx.unsafe(`explain (generic_plan, format json) ${list.sql}`);
    });
    expect(JSON.stringify(plan[0]["QUERY PLAN"])).toContain("people_org_contacts_idx");
  });

  describe("board", () => {
    it("pages each column by 25 with a cursor, totals per currency, and filters by owner and search", async () => {
      const f = await kit.organization();
      for (let i = 0; i < 27; i += 1) await create(f, await f.person({ name: `Lead ${String(i).padStart(2, "0")}` }), i < 3 ? { amount: "100", currency: "USD" } : i < 5 ? { amount: "5000", currency: "KRW", ownerId: f.member.userId } : {});
      const first = await deals.board(composition.dealsDeps(), f.owner);
      const column = first.columns[0];
      expect(first.virtual).toBe(false);
      expect(first.columns.map((c) => c.name)).toEqual(["New", "Meeting", "Proposal", "Won", "Lost"]);
      expect(column).toMatchObject({ total: 27, amounts: [{ currency: "KRW", amountMinor: "10000" }, { currency: "USD", amountMinor: "30000" }] });
      expect(column.cards).toHaveLength(25);
      expect(column.nextCursor).not.toBeNull();
      // Newest stage move first.
      expect(column.cards[0].personName).toBe("Lead 26");
      const next = await deals.board(composition.dealsDeps(), f.owner, { stage: column.id, cursor: column.nextCursor });
      expect(next.columns).toHaveLength(1);
      expect(next.columns[0].cards.map((c) => c.personName)).toEqual(["Lead 01", "Lead 00"]);
      expect(next.columns[0].nextCursor).toBeNull();
      const ids = new Set([...column.cards, ...next.columns[0].cards].map((c) => c.id));
      expect(ids.size).toBe(27);

      const mine = await deals.board(composition.dealsDeps(), f.member, { owner: "me" });
      expect(mine.columns[0]).toMatchObject({ total: 2, amounts: [{ currency: "KRW", amountMinor: "10000" }] });
      expect(mine.columns[0].cards[0].owner).toEqual({ userId: f.member.userId, name: "Member", isMember: true });
      expect((await deals.board(composition.dealsDeps(), f.owner, { owner: "none" })).columns[0].total).toBe(0);
      expect((await deals.board(composition.dealsDeps(), f.owner, { q: "Lead 1" })).columns[0].total).toBe(10);
      expect((await deals.board(composition.dealsDeps(), f.owner, { q: "%" })).columns[0].total).toBe(0);
      await expect(deals.board(composition.dealsDeps(), f.owner, { owner: "someone" })).rejects.toThrow("Filter by");
      await expect(deals.board(composition.dealsDeps(), f.owner, { cursor: column.nextCursor })).rejects.toThrow("cursor");
    });

    it("refuses a cursor that does not decode and answers an empty page past the end", async () => {
      const f = await kit.organization();
      await create(f, await f.person({ name: "Only" }));
      const stageId = (await composition.dealsDeps().store.listStages(f.org))[0].id;
      const read = (cursor: string) => crm.crmRead.board(f.org, { stageIds: [stageId], limit: 5, cursor, closedSince: null });
      for (const cursor of ["garbage", crm.encodeCursor("yesterday", "00000000-0000-4000-8000-000000000000"), crm.encodeCursor("2026-10-01T00:00:00Z", "not-a-uuid-0000-0000-0000-000000000000")]) {
        await expect(read(cursor)).rejects.toBeInstanceOf(ValidationError);
      }
      const [past] = await read(crm.encodeCursor("1970-01-01T00:00:00.000000Z", "00000000-0000-4000-8000-000000000000"));
      expect(past).toMatchObject({ total: 1, cards: [], nextCursor: null });
    });

    it("keeps a column total above 2^53 - 1 exact", async () => {
      const f = await kit.organization();
      // The stored maximum (2^53 - 1 minor units) and one less: Number("18014398509481981") rounds to ...980.
      await create(f, await f.person({ name: "Big A" }), { amount: "90071992547409.91", currency: "USD" });
      await create(f, await f.person({ name: "Big B" }), { amount: "90071992547409.90", currency: "USD" });
      const column = (await deals.board(composition.dealsDeps(), f.owner)).columns[0];
      expect(column.amounts).toEqual([{ currency: "USD", amountMinor: "18014398509481981" }]);
    });

    it("shows Won and Lost of the last 30 days, all of them with showAll, against an injected clock", async () => {
      const f = await kit.organization();
      const stages = await (async () => {
        await create(f, await f.person({ name: "Open one" }));
        return composition.dealsDeps().store.listStages(f.org);
      })();
      const won = stages.find((s) => s.kind === "won")!;
      const lost = stages.find((s) => s.kind === "lost")!;
      const close = async (name: string, stageId: string, at: string, reason?: string) => {
        const { dealId } = await create(f, await f.person({ name }));
        await deals.moveDealStage(composition.dealsDeps({ now: () => new Date(at) }), f.owner, dealId, { stageId, expectedVersion: 0, lostReason: reason });
      };
      await close("Recent win", won.id, "2026-10-10T00:00:00Z");
      await close("Old win", won.id, "2026-08-01T00:00:00Z");
      await close("Recent loss", lost.id, "2026-10-01T00:00:00Z", "Timing");
      await close("Old loss", lost.id, "2026-09-01T00:00:00Z", "Budget");
      const at = (now: string, showAll = false) => deals.board(composition.dealsDeps({ now: () => new Date(now) }), f.owner, { showAll });
      const names = (b: Awaited<ReturnType<typeof at>>, kind: string) => b.columns.filter((c) => c.kind === kind).flatMap((c) => c.cards.map((x) => x.personName));
      const windowed = await at("2026-10-16T00:00:00Z");
      expect(windowed.closedSince?.toISOString()).toBe("2026-09-16T00:00:00.000Z");
      expect(names(windowed, "won")).toEqual(["Recent win"]);
      expect(names(windowed, "lost")).toEqual(["Recent loss"]);
      expect(names(windowed, "open")).toEqual(["Open one"]);
      expect(windowed.columns.find((c) => c.kind === "won")?.total).toBe(1);
      const all = await at("2026-10-16T00:00:00Z", true);
      expect(all.closedSince).toBeNull();
      expect(names(all, "won")).toEqual(["Recent win", "Old win"]);
      expect(names(all, "lost")).toEqual(["Recent loss", "Old loss"]);
      expect(names(await at("2026-11-20T00:00:00Z"), "won")).toEqual([]);
    });

    it("an organization without stages sees the default columns, and nothing is written", async () => {
      const f = await kit.organization();
      const view = await deals.board(composition.dealsDeps(), f.owner);
      expect(view.virtual).toBe(true);
      expect(view.columns.map((c) => [c.id, c.name, c.total])).toEqual([[null, "New", 0], [null, "Meeting", 0], [null, "Proposal", 0], [null, "Won", 0], [null, "Lost", 0]]);
      expect(await kit.count("deal_stages", f.org)).toBe(0);
    });
  });

  describe("Contacts list", () => {
    it("lists contacts only, newest conversion first, with open deals and visible last activity; searches and pages", async () => {
      const f = await kit.organization();
      const zenith = await f.company("Zenith");
      await f.person({ name: "Still a lead" });
      const ada = await f.person({ name: "Ada", companyId: zenith });
      const bob = await f.person({ name: "Bob" });
      await create(f, ada);
      await create(f, bob);
      await deals.createDealForContact(composition.dealsDeps(), f.owner, ada, { idempotencyKey: "second" });
      const listed = await deals.listContacts(composition.dealsDeps(), f.owner);
      expect(listed).toMatchObject({ total: 2, page: 1, pageSize: 25 });
      expect(listed.rows.map((r) => [r.name, r.openDeals, r.companyName])).toEqual([["Bob", 1, null], ["Ada", 2, "Zenith"]]);
      expect(listed.rows[0].lastActivityAt).toBeInstanceOf(Date);
      expect((await deals.listContacts(composition.dealsDeps(), f.owner, { sort: "name" })).rows.map((r) => r.name)).toEqual(["Ada", "Bob"]);
      expect((await deals.listContacts(composition.dealsDeps(), f.owner, { q: "zenith" })).rows.map((r) => r.name)).toEqual(["Ada"]);
      expect((await deals.listContacts(composition.dealsDeps(), f.owner, { page: 2 })).rows).toEqual([]);
      await expect(deals.listContacts(composition.dealsDeps(), f.owner, { sort: "email" })).rejects.toThrow("Sort contacts");
    });

    it("shows each contact's latest deal with its owner and do not contact, and filters by that deal's owner and stage", async () => {
      const f = await kit.organization();
      const ada = await f.person({ name: "Ada" });
      const bob = await f.person({ name: "Bob" });
      const cy = await f.person({ name: "Cy" });
      await create(f, ada);
      const stages = await composition.dealsDeps().store.listStages(f.org);
      const first = stages[0];
      const won = stages.find((s) => s.kind === "won")!;
      // Ada: an older deal of the owner, then a newer one of the member. The newer open deal is the latest.
      await deals.createDealForContact(composition.dealsDeps(), f.owner, ada, { ownerId: f.member.userId, idempotencyKey: "ada-2" });
      // Bob: one deal, won. Without an open deal the latest is the most recent one.
      const { dealId: bobDeal } = await create(f, bob);
      await deals.moveDealStage(composition.dealsDeps(), f.owner, bobDeal, { stageId: won.id, expectedVersion: 0 });
      await create(f, cy, { ownerId: null });
      await kit.sql`insert into contact_policies (person_id, organization_id, do_not_contact, source, set_at) values (${bob}, ${f.org}, true, 'human', now())`;

      const list = (input: Parameters<typeof deals.listContacts>[2] = {}, actor = f.owner) => deals.listContacts(composition.dealsDeps(), actor, { sort: "name", ...input });
      const all = await list();
      expect(all.rows.map((r) => [r.name, r.latestDeal?.stageName, r.latestDeal?.owner?.name ?? null, r.doNotContact])).toEqual([
        ["Ada", first.name, "Member", false],
        ["Bob", won.name, "Owner", true],
        ["Cy", first.name, null, false],
      ]);
      expect(all.rows[0].latestDeal?.owner).toEqual({ userId: f.member.userId, name: "Member", isMember: true });
      expect(all.rows[0].openDeals).toBe(2);
      // The list's SQL pick and primaryDeal, which the contact page and the Inbox use, name the same deal.
      const summaries = await deals.dealSummaryForPeople(composition.dealsDeps(), f.owner, [ada, bob, cy]);
      expect(all.rows.map((r) => r.latestDeal?.id)).toEqual([ada, bob, cy].map((id) => summaries.get(id)?.latestDealId));

      const names = async (input: Parameters<typeof deals.listContacts>[2], actor = f.owner) => {
        const result = await list(input, actor);
        return { names: result.rows.map((r) => r.name), total: result.total };
      };
      expect(await names({ owner: "me" })).toEqual({ names: ["Bob"], total: 1 });
      expect(await names({ owner: "me" }, f.member)).toEqual({ names: ["Ada"], total: 1 });
      expect(await names({ owner: f.member.userId })).toEqual({ names: ["Ada"], total: 1 });
      expect(await names({ owner: "none" })).toEqual({ names: ["Cy"], total: 1 });
      expect(await names({ stage: won.id })).toEqual({ names: ["Bob"], total: 1 });
      expect(await names({ stage: first.id })).toEqual({ names: ["Ada", "Cy"], total: 2 });
      expect(await names({ stage: first.id, owner: "none" })).toEqual({ names: ["Cy"], total: 1 });
      expect(await names({ stage: first.id, q: "ada" })).toEqual({ names: ["Ada"], total: 1 });
      // An id of nothing in this organization lists nothing.
      const stranger = "00000000-0000-4000-8000-000000000000";
      expect(await names({ owner: stranger })).toEqual({ names: [], total: 0 });
      expect(await names({ stage: stranger })).toEqual({ names: [], total: 0 });
      const other = await kit.organization();
      await create(other, await other.person({ name: "Elsewhere" }));
      const otherStage = (await composition.dealsDeps().store.listStages(other.org))[0];
      expect(await names({ stage: otherStage.id })).toEqual({ names: [], total: 0 });
      await expect(list({ owner: "someone" })).rejects.toThrow("Filter by");
      await expect(list({ stage: "new" })).rejects.toThrow("Pick a stage");
    });

    it("last activity leaves out the events of a record whose threads are all private", async () => {
      const f = await kit.organization();
      const personId = await f.person({ name: "Private" });
      await create(f, personId);
      const [pipeline] = await kit.sql`select id from reply_type_sets where organization_id = ${f.org} limit 1`.then(async (rows) => (rows.length ? rows : kit.sql`insert into reply_type_sets (organization_id, name) values (${f.org}, 'Default') returning id`));
      const [record] = await kit.sql`insert into records (organization_id, person_id, reply_type_set_id) values (${f.org}, ${personId}, ${pipeline.id}) returning id`;
      const campaign = await f.campaign({ type: "personal", createdBy: f.owner.userId });
      await kit.sql`insert into conversations (organization_id, record_id, channel, account_ref, private_campaign_id) values (${f.org}, ${record.id}, 'linkedin', ${`acct-${f.tag}`}, ${campaign})`;
      const before = (await deals.listContacts(composition.dealsDeps(), f.owner)).rows[0].lastActivityAt;
      await kit.sql`insert into events (organization_id, person_id, record_id, event_type, actor_type, created_at) values (${f.org}, ${personId}, ${record.id}, 'test.private', 'system', now() + interval '1 hour')`;
      expect((await deals.listContacts(composition.dealsDeps(), f.owner)).rows[0].lastActivityAt).toEqual(before);
    });
  });

  describe("Companies list and company page", () => {
    it("lists companies with a contact and no stamp, counts contacts and open deals, and a company appears once a contact attaches", async () => {
      const f = await kit.organization();
      const acme = await f.company("Acme");
      const beta = await f.company("Beta");
      const leadsOnly = await f.company("Leads Only");
      const c1 = await f.person({ companyId: acme });
      const c2 = await f.person({ companyId: acme });
      const c3 = await f.person({ companyId: acme });
      await f.person({ companyId: acme });
      const c4 = await f.person({ companyId: beta });
      const lead = await f.person({ companyId: leadsOnly });
      for (const id of [c1, c2]) await create(f, id);
      const { dealId } = await create(f, c3);
      const { dealId: betaDeal } = await create(f, c4);
      const won = (await composition.dealsDeps().store.listStages(f.org)).find((s) => s.kind === "won")!;
      await deals.moveDealStage(composition.dealsDeps(), f.owner, dealId, { stageId: won.id, expectedVersion: 0 });
      await deals.moveDealStage(composition.dealsDeps(), f.owner, betaDeal, { stageId: won.id, expectedVersion: 0 });

      const listed = await deals.listCompanies(composition.dealsDeps(), f.owner);
      expect(listed.rows.map((r) => [r.name, r.contacts, r.openDeals])).toEqual([["Acme", 3, 2], ["Beta", 1, 0]]);
      expect(listed.total).toBe(2);
      expect((await deals.listCompanies(composition.dealsDeps(), f.owner, { sort: "open_deals" })).rows[0].name).toBe("Acme");
      expect((await deals.listCompanies(composition.dealsDeps(), f.owner, { q: "bet" })).rows.map((r) => r.name)).toEqual(["Beta"]);

      await create(f, lead);
      expect((await deals.listCompanies(composition.dealsDeps(), f.owner)).rows.map((r) => r.name)).toEqual(["Acme", "Beta", "Leads Only"]);

      const page = await deals.getCompany(composition.dealsDeps(), f.owner, acme);
      expect(page.company).toMatchObject({ id: acme, name: "Acme" });
      expect(page.contacts.map((c) => c.id).sort()).toEqual([c1, c2, c3].sort());
      expect(page.deals).toHaveLength(3);
      expect(page.summary).toMatchObject({ contacts: 3, openDeals: 2 });
      expect((await deals.getCompany(composition.dealsDeps(), f.owner, beta)).summary).toMatchObject({ contacts: 1, openDeals: 0 });
      const other = await kit.organization();
      await expect(deals.getCompany(composition.dealsDeps(), other.owner, acme)).rejects.toThrow("Company not found");
      expect((await deals.listCompanies(composition.dealsDeps(), other.owner)).rows).toEqual([]);
    });

    it("shows the latest activity among a company's contacts and the open amounts per currency, exact past 2^53 - 1", async () => {
      const f = await kit.organization();
      const acme = await f.company("Acme");
      const beta = await f.company("Beta");
      const quiet = await f.company("Quiet");
      const a1 = await f.person({ companyId: acme });
      const a2 = await f.person({ companyId: acme });
      const a3 = await f.person({ companyId: acme });
      const b1 = await f.person({ companyId: beta });
      await f.person({ companyId: quiet, contact: true });
      await create(f, a1, { amount: "10", currency: "USD" });
      await create(f, a2, { amount: "5.50", currency: "USD" });
      await deals.createDealForContact(composition.dealsDeps(), f.owner, a2, { amount: "3", currency: "EUR", idempotencyKey: "a2-eur" });
      await create(f, a3);
      const { dealId: closed } = await create(f, b1, { amount: "100", currency: "USD" });
      const won = (await composition.dealsDeps().store.listStages(f.org)).find((s) => s.kind === "won")!;
      await deals.moveDealStage(composition.dealsDeps(), f.owner, closed, { stageId: won.id, expectedVersion: 0 });
      const later = new Date(Date.now() + 86_400_000);
      await kit.sql`insert into events (organization_id, person_id, event_type, actor_type, created_at) values (${f.org}, ${a3}, 'test.later', 'system', ${later})`;

      const listed = await deals.listCompanies(composition.dealsDeps(), f.owner);
      expect(listed.rows.map((r) => [r.name, r.openAmounts])).toEqual([
        ["Acme", [{ currency: "EUR", amountMinor: "300" }, { currency: "USD", amountMinor: "1550" }]],
        ["Beta", []],
        ["Quiet", []],
      ]);
      expect(listed.rows[0].lastActivityAt?.getTime()).toBe(later.getTime());
      expect(listed.rows[1].lastActivityAt).toBeInstanceOf(Date);
      // A contact with no event at all.
      expect(listed.rows[2].lastActivityAt).toBeNull();
      expect((await deals.getCompany(composition.dealsDeps(), f.owner, acme)).summary.openAmounts).toEqual([{ currency: "EUR", amountMinor: "300" }, { currency: "USD", amountMinor: "1550" }]);

      const big = await f.company("Big");
      await create(f, await f.person({ companyId: big }), { amount: "90071992547409.91", currency: "USD" });
      await create(f, await f.person({ companyId: big }), { amount: "90071992547409.90", currency: "USD" });
      expect((await deals.listCompanies(composition.dealsDeps(), f.owner, { q: "big" })).rows[0].openAmounts).toEqual([{ currency: "USD", amountMinor: "18014398509481981" }]);
    });

    it("lists a company with a listing stamp even without contacts, or with a contact today, and leaves leads-only companies off", async () => {
      const f = await kit.organization();
      const added = await f.company("Added");
      const withContact = await f.company("With contact");
      const leftBehind = await f.company("Left behind");
      const leadsOnly = await f.company("Leads only");
      const moved = await f.company("Moved to");
      await kit.sql`update companies set crm_listed_at = now() - interval '1 day' where id = ${added}`;
      await f.person({ companyId: withContact, contact: true });
      await f.person({ companyId: leadsOnly });
      // The contact moved away and the use case that moved them stamped the company it left.
      const mover = await f.person({ companyId: leftBehind, contact: true });
      await kit.sql`update people set company_id = ${moved} where id = ${mover}`;
      await kit.sql`update companies set crm_listed_at = now() where id = ${leftBehind}`;

      const listed = await deals.listCompanies(composition.dealsDeps(), f.owner);
      expect(listed.rows.map((r) => [r.name, r.contacts, r.openDeals, r.lastActivityAt])).toEqual([
        ["Added", 0, 0, null],
        ["Left behind", 0, 0, null],
        ["Moved to", 1, 0, null],
        ["With contact", 1, 0, null],
      ]);
      expect(listed.total).toBe(4);
      expect((await deals.listCompanies(composition.dealsDeps(), f.owner, { sort: "contacts" })).rows.map((r) => r.name)).toEqual(["Moved to", "With contact", "Added", "Left behind"]);
      expect((await deals.listCompanies(composition.dealsDeps(), f.owner, { q: "added" })).rows.map((r) => r.name)).toEqual(["Added"]);
      // A contact that becomes nobody's: the unstamped company leaves the list once no contact points at it.
      await kit.sql`update people set company_id = null where company_id = ${withContact}`;
      expect((await deals.listCompanies(composition.dealsDeps(), f.owner)).rows.map((r) => r.name)).toEqual(["Added", "Left behind", "Moved to"]);
      expect((await deals.getCompany(composition.dealsDeps(), f.owner, added)).summary).toMatchObject({ contacts: 0, openDeals: 0, openAmounts: [] });
    });

    it("the company page reads version, the listing stamp, other domains oldest first and people counts, for any company of the organization", async () => {
      const f = await kit.organization();
      const acme = await f.company("Acme");
      await f.person({ companyId: acme, contact: true });
      await f.person({ companyId: acme });
      await f.person({ companyId: acme });
      await kit.sql`update companies set version = 3, crm_listed_at = '2026-10-01T09:00:00Z' where id = ${acme}`;
      await kit.sql`insert into company_domain_aliases (organization_id, company_id, domain, merged_name, created_at) values
        (${f.org}, ${acme}, ${`globex-${f.tag}.test`}, 'Globex', now() - interval '2 days'),
        (${f.org}, ${acme}, ${`acme-old-${f.tag}.test`}, null, now() - interval '1 day')`;
      expect(await crm.crmRead.company(f.org, acme)).toMatchObject({
        version: 3,
        crmListedAt: new Date("2026-10-01T09:00:00Z"),
        aliases: [
          { domain: `globex-${f.tag}.test`, mergedName: "Globex" },
          { domain: `acme-old-${f.tag}.test`, mergedName: null },
        ],
        contacts: 1,
        leads: 2,
      });
      const bare = await f.company("Bare");
      expect(await crm.crmRead.company(f.org, bare)).toMatchObject({ version: 0, crmListedAt: null, aliases: [], contacts: 0, leads: 0 });
      expect((await deals.getCompany(composition.dealsDeps(), f.owner, acme)).company).toMatchObject({ version: 3, contacts: 1, leads: 2 });
      const other = await kit.organization();
      expect(await crm.crmRead.company(other.org, acme)).toBeNull();
    });

    it("pages 25 at a time without gaps when sort values tie, and searches name and domain literally", async () => {
      const f = await kit.organization();
      await kit.sql`
        with c as (
          insert into companies (organization_id, domain, name)
          select ${f.org}, 'tie' || g || '-' || ${f.tag} || '.test', 'Same' from generate_series(1, 60) g
          returning id
        )
        insert into people (organization_id, full_name, company_id, lifecycle, converted_at)
        select ${f.org}, 'Tied', c.id, 'contact', '2026-10-01T10:00:00Z' from c`;
      for (const sort of ["name", "contacts", "open_deals"]) {
        const seen: string[] = [];
        for (let page = 1; page <= 3; page += 1) seen.push(...(await deals.listCompanies(composition.dealsDeps(), f.owner, { sort, page })).rows.map((r) => r.id));
        expect(new Set(seen).size, sort).toBe(60);
      }
      const first = await deals.listCompanies(composition.dealsDeps(), f.owner);
      expect(first.rows).toHaveLength(25);
      expect(first.total).toBe(60);
      expect((await deals.listCompanies(composition.dealsDeps(), f.owner, { page: 4 })).rows).toEqual([]);
      expect((await deals.listCompanies(composition.dealsDeps(), f.owner, { q: "%" })).total).toBe(0);
      expect((await deals.listCompanies(composition.dealsDeps(), f.owner, { q: "tie7-" })).rows.map((r) => r.domain)).toEqual([`tie7-${f.tag}.test`]);
      expect((await deals.listCompanies(composition.dealsDeps(), f.owner, { q: "same" })).total).toBe(60);
      await expect(deals.listCompanies(composition.dealsDeps(), f.owner, { sort: "updated" })).rejects.toThrow("Sort companies");

      const contactsSeen: string[] = [];
      for (let page = 1; page <= 3; page += 1) contactsSeen.push(...(await deals.listContacts(composition.dealsDeps(), f.owner, { page })).rows.map((r) => r.id));
      expect(new Set(contactsSeen).size, "contacts with one conversion time").toBe(60);
    });

    it("counts only the caller's organization, and only contacts", async () => {
      const a = await kit.organization();
      const b = await kit.organization();
      const shared = await a.company("Shared", `shared-${a.tag}.test`);
      const sharedB = await b.company("Shared B", `shared-${a.tag}.test`);
      await a.person({ companyId: shared, contact: true });
      await a.person({ companyId: shared, contact: true });
      await a.person({ companyId: shared });
      await b.person({ companyId: sharedB });
      expect((await deals.listCompanies(composition.dealsDeps(), a.owner)).rows.map((r) => `${r.name}:${r.contacts}:${r.openDeals}`)).toEqual(["Shared:2:0"]);
      expect((await deals.listCompanies(composition.dealsDeps(), b.owner)).rows).toEqual([]);
      // The company page still answers for a company of the organization without contacts, with empty lists.
      expect(await deals.getCompany(composition.dealsDeps(), b.owner, sharedB)).toMatchObject({ contacts: [], deals: [] });
      await expect(deals.getCompany(composition.dealsDeps(), b.owner, shared)).rejects.toThrow("Company not found");
      await expect(deals.getCompany(composition.dealsDeps(), a.owner, "not-a-uuid")).rejects.toThrow("Company not found");
    });
  });

  describe("Contacts selection and export", () => {
    const csvOf = async (chunks: AsyncGenerator<string>) => {
      let text = "";
      for await (const chunk of chunks) text += chunk;
      return text;
    };

    it("contactIds answers the filter's ids newest conversion first, the full count, and caps", async () => {
      const f = await kit.organization();
      const ada = await f.person({ name: "Ada" });
      const bob = await f.person({ name: "Bob" });
      await f.person({ name: "Lead only" });
      await create(f, ada, { ownerId: f.member.userId });
      await create(f, bob);
      const ids = (input: Parameters<typeof deals.listContactIds>[2] = {}, actor = f.owner) => deals.listContactIds(composition.dealsDeps(), actor, input);
      expect(await ids()).toEqual({ ids: [bob, ada], total: 2, capped: false });
      expect(await ids({ owner: "me" }, f.member)).toEqual({ ids: [ada], total: 1, capped: false });
      expect(await ids({ q: "bob" })).toEqual({ ids: [bob], total: 1, capped: false });
      expect(await ids({ q: "nobody" })).toEqual({ ids: [], total: 0, capped: false });
      expect(await crm.crmRead.contactIds(f.org, {}, 1)).toEqual({ ids: [bob], total: 2 });
      await expect(ids({ owner: "someone" })).rejects.toThrow("Filter by");
      expect((await kit.organization().then((o) => deals.listContactIds(composition.dealsDeps(), o.owner))).ids).toEqual([]);
    });

    it("exports the Contacts columns with Deal owner, ISO dates in the organization zone and custom fields in Settings order", async () => {
      const f = await kit.organization();
      const acme = await f.company("Acme", `acme-${f.tag}.test`);
      // 23:30 UTC on the 18th is the 19th in Seoul. `converted_at` never changes once set, so the rows start as contacts.
      const contact = async (name: string, convertedAt: string, companyId: string | null) =>
        (await kit.one("insert into people (organization_id, full_name, company_id, lifecycle, converted_at) values ($1, $2, $3, 'contact', $4) returning id", [f.org, name, companyId, convertedAt])).id as string;
      const ada = await contact("Ada", "2026-10-18T23:30:00Z", acme);
      const bob = await contact("=Bob", "2026-10-18T10:00:00Z", null);
      await f.person({ name: "Lead only" });
      await kit.sql`update people set email = ${`ada-${f.tag}@acme.test`}, phone = '+82 10 1234 5678', title = 'CTO', linkedin_slug = 'ada-k', custom = ${kit.sql.json({ x_tier: "Gold", x_region: "APAC", x_old: "gone" })} where id = ${ada}`;
      await kit.sql`insert into entity_columns (organization_id, entity, key, name, type, position, archived_at) values
        (${f.org}, 'people', 'x_region', 'Region', 'text', 2, null),
        (${f.org}, 'people', 'x_tier', 'Tier', 'text', 1, null),
        (${f.org}, 'people', 'x_old', 'Old', 'text', 0, now()),
        (${f.org}, 'companies', 'x_size', 'Size', 'text', 0, null)`;
      await deals.createDealForContact(composition.dealsDeps(), f.owner, ada, { title: "Acme, Ada", ownerId: f.member.userId, idempotencyKey: "ada-deal" });
      await deals.createDealForContact(composition.dealsDeps(), f.owner, bob, { ownerId: null, idempotencyKey: "bob-deal" });
      // Events are append-only, so a later event sets Ada's last activity.
      await kit.sql`insert into events (organization_id, person_id, event_type, actor_type, created_at) values (${f.org}, ${ada}, 'test.later', 'system', '2099-10-19T16:00:00Z')`;
      const stage = (await composition.dealsDeps().store.listStages(f.org))[0];
      const adaEmail = `ada-${f.tag}@acme.test`;
      const bobActivity = (await kit.one("select to_char(max(created_at) at time zone 'Asia/Seoul', 'YYYY-MM-DD') as day from events where person_id = $1", [bob])).day as string;

      const csv = await csvOf(deals.exportContactsCsv(composition.dealsDeps(), f.owner, { filter: {} }, "Asia/Seoul"));
      expect(csv.startsWith("\uFEFF")).toBe(true);
      expect(csv.slice(1).split("\r\n")).toEqual([
        "Name,Email,Phone,LinkedIn,Job title,Company,Company domain,Deal owner,Latest deal,Stage,Open deals,Contact since,Last activity,Tier,Region",
        `Ada,${adaEmail},'+82 10 1234 5678,https://www.linkedin.com/in/ada-k/,CTO,Acme,acme-${f.tag}.test,Member,"Acme, Ada",${stage.name},1,2026-10-19,2099-10-20,Gold,APAC`,
        `'=Bob,,,,,,,,'=Bob,${stage.name},1,2026-10-18,${bobActivity},,`,
        "",
      ]);

      const utc = await csvOf(deals.exportContactsCsv(composition.dealsDeps(), f.owner, { filter: {} }, "Not/AZone"));
      expect(utc).toContain(",2026-10-18,2099-10-19,Gold,APAC");
      const selected = await csvOf(deals.exportContactsCsv(composition.dealsDeps(), f.owner, { ids: [bob, "not-a-uuid"] }, "UTC"));
      expect(selected.slice(1).split("\r\n")).toHaveLength(3);
      expect(selected).toContain("'=Bob");
      expect(selected).not.toContain("Ada");
      const filtered = await csvOf(deals.exportContactsCsv(composition.dealsDeps(), f.member, { filter: { owner: "me" } }, "UTC"));
      expect(filtered.slice(1).split("\r\n").slice(1, -1).map((line) => line.split(",")[0])).toEqual(["Ada"]);
      const other = await kit.organization();
      const foreign = await csvOf(deals.exportContactsCsv(composition.dealsDeps(), other.owner, { ids: [ada, bob] }, "UTC"));
      expect(foreign.slice(1).split("\r\n")).toEqual(["Name,Email,Phone,LinkedIn,Job title,Company,Company domain,Deal owner,Latest deal,Stage,Open deals,Contact since,Last activity", ""]);
      await expect(csvOf(deals.exportContactsCsv(composition.dealsDeps(), f.owner, { ids: Array.from({ length: 5001 }, () => ada) }, "UTC"))).rejects.toThrow("Export up to 5000");
    });

    it("exports in batches of 1,000 without gaps or repeats when conversion times tie", async () => {
      const f = await kit.organization();
      await kit.sql`
        insert into people (organization_id, full_name, lifecycle, converted_at)
        select ${f.org}, 'Tied ' || g, 'contact', '2026-10-01T10:00:00Z' from generate_series(1, 2100) g`;
      const batches: number[] = [];
      const seen = new Set<string>();
      for await (const batch of crm.crmRead.contactsForExport(f.org, { filter: {} }, "UTC")) {
        batches.push(batch.length);
        for (const row of batch) seen.add(row.id);
      }
      expect(batches).toEqual([1000, 1000, 100]);
      expect(seen.size).toBe(2100);
    });
  });
});
