import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { ValidationError } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { DEFAULT_LEAD_SORT, type LeadFilter, type LeadSort } from "../../domain/lead-filter";
import type { ReadLeadStatuses } from "@/contexts/outreach/domain/lead-status";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("lead list filters, sort and companies", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let uc: typeof import("../../application/lead-management");
  let q: typeof import("@/composition/leads");
  let deps: import("../../application/lead-ports").LeadDeps & import("../../application/lead-ports").LeadDeleteDeps;
  let readLeadStatuses: ReadLeadStatuses;
  let readLeadNeighbors: typeof import("@/composition/leads").readLeadNeighbors;
  const orgs: TestOrg[] = [];

  async function org() {
    const created = await createTestOrg(sql, "F", "member");
    orgs.push(created);
    const actor: Actor = { userId: created.userId, organizationId: created.organizationId, role: "member" };
    return { id: created.organizationId, actor };
  }

  const company = async (orgId: string, domain: string, name: string | null = null) => {
    const [{ id }] = await sql`insert into companies (organization_id, domain, name) values (${orgId}, ${domain}, ${name}) returning id`;
    return id as string;
  };

  interface PersonSeed {
    email?: string | null;
    slug?: string | null;
    url?: string | null;
    phone?: string | null;
    name?: string | null;
    title?: string | null;
    companyId?: string | null;
    source?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }
  const person = async (orgId: string, p: PersonSeed) => {
    const [{ id }] = await sql`
      insert into people (organization_id, email, linkedin_slug, linkedin_url, phone, full_name, title, company_id, source, created_at, updated_at)
      values (${orgId}, ${p.email ?? null}, ${p.slug ?? null}, ${p.url ?? null}, ${p.phone ?? null}, ${p.name ?? null}, ${p.title ?? null}, ${p.companyId ?? null},
        ${p.source ?? null}, ${p.createdAt ?? new Date().toISOString()}, ${p.updatedAt ?? p.createdAt ?? new Date().toISOString()})
      returning id`;
    return id as string;
  };

  const campaign = async (orgId: string, channel: "email" | "linkedin", name: string) => {
    const [{ id }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${orgId}, ${channel}, ${name}, 'draft') returning id`;
    return id as string;
  };
  const enroll = async (orgId: string, campaignId: string, personId: string, channel: "email" | "linkedin", status = "pending") => {
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${orgId}, ${campaignId}, ${personId}, ${channel}, ${status})`;
  };

  const ids = async (orgId: string, filter: LeadFilter, sort?: LeadSort) => {
    const result = await q.listLeads(orgId, { filter, sort, pageSize: 200 });
    return result.rows.map((r) => r.id).sort();
  };
  const sorted = (...list: string[]) => [...list].sort();

  const csvOf = async (actor: Actor, filter: LeadFilter) => {
    let text = "";
    for await (const chunk of uc.exportLeadsCsv(deps, actor, filter)) text += chunk;
    return text;
  };

  beforeAll(async () => {
    uc = await import("../../application/lead-management");
    q = await import("@/composition/leads");
    deps = { ...(await import("@/composition/person-lifecycle")).leadDeleteDeps, ...(await import("@/composition/leads")).leadDeps() };
    ({ readLeadStatuses } = await import("@/read-models/lead-activity"));
    ({ readLeadNeighbors } = q);
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  /** One organization with a lead for each filter to find. */
  async function seed() {
    const o = await org();
    const acme = await company(o.id, "acme.com", "Acme");
    const zeta = await company(o.id, "zeta.io", "Zeta");
    const c1 = await campaign(o.id, "email", "Email push");
    const c2 = await campaign(o.id, "linkedin", "LinkedIn push");
    const alice = await person(o.id, {
      email: "alice@acme.com", slug: "alice-a", url: "https://www.linkedin.com/in/alice-a/", phone: "+14155550101", name: "Alice Adams", title: "CEO",
      companyId: acme, source: "import:run1", createdAt: "2024-01-10T12:00:00Z",
    });
    const bob = await person(o.id, { email: "bob@zeta.io", name: "Bob Brown", title: "CTO", companyId: zeta, source: "manual", createdAt: "2024-02-10T12:00:00Z" });
    const carol = await person(o.id, { slug: "carol-c", url: "https://www.linkedin.com/in/carol-c/", name: "Carol Cruz", source: "grid:t1", createdAt: "2024-03-10T12:00:00Z" });
    const dan = await person(o.id, { email: "dan@acme.com", name: "Dan Diaz", companyId: acme, source: "import:run2", createdAt: "2024-04-10T23:30:00Z" });
    const eve = await person(o.id, { email: "eve@zeta.io", name: "Eve Evans", companyId: zeta, source: "import:run1", createdAt: "2024-05-10T12:00:00Z" });
    const frank = await person(o.id, { email: "frank@acme.com", slug: "frank-f", name: "Frank Fox", companyId: acme, source: "import:run1", createdAt: "2024-06-10T12:00:00Z" });

    await sql`insert into contact_policies (person_id, organization_id, do_not_contact, reason, source, set_at) values (${dan}, ${o.id}, true, 'asked', 'human', now())`;
    await enroll(o.id, c1, eve, "email", "active");
    await enroll(o.id, c1, alice, "email");
    await enroll(o.id, c2, carol, "linkedin");
    // A cancelled enrollment still counts as membership; only "removed" does not.
    await enroll(o.id, c2, frank, "linkedin", "cancelled");
    const [{ id: pipeline }] = await sql`insert into reply_type_sets (organization_id, name) values (${o.id}, 'P') returning id`;
    await sql`insert into records (organization_id, person_id, reply_type_set_id, group_key, reply_type_source) values (${o.id}, ${bob}, ${pipeline}, 'interested', 'human')`;
    return { ...o, acme, zeta, c1, c2, alice, bob, carol, dan, eve, frank, all: sorted(alice, bob, carol, dan, eve, frank) };
  }

  describe("filters alone", () => {
    it("does not count a personal campaign as a campaign membership, like the Status column", async () => {
      const s = await seed();
      const [{ id: personal }] = await sql`insert into campaigns (organization_id, channel, name, status, type) values (${s.id}, 'linkedin', 'Personal thread', 'draft', 'personal') returning id`;
      // Bob has only a personal enrollment; Eve has a regular one and a personal one.
      await enroll(s.id, personal, s.bob, "linkedin");
      await enroll(s.id, personal, s.eve, "linkedin");
      expect(await ids(s.id, { campaign: "any" })).toEqual(sorted(s.eve, s.alice, s.carol, s.frank));
      expect(await ids(s.id, { campaign: "none" })).toEqual(sorted(s.bob, s.dan));
    });

    it("narrows by campaign membership, exclusion and a named campaign", async () => {
      const s = await seed();
      expect(await ids(s.id, { campaign: "any" })).toEqual(sorted(s.eve, s.alice, s.carol, s.frank));
      expect(await ids(s.id, { campaign: "none" })).toEqual(sorted(s.bob, s.dan));
      expect(await ids(s.id, { campaign: s.c1 })).toEqual(sorted(s.eve, s.alice));
      expect(await ids(s.id, { campaign: s.c2 })).toEqual(sorted(s.carol, s.frank));
      expect(await ids(s.id, { notInCampaign: s.c1 })).toEqual(sorted(s.bob, s.carol, s.dan, s.frank));
    });

    it("does not count a removed enrollment as membership", async () => {
      const s = await seed();
      await sql`update campaign_enrollments set status = 'cancelled' where person_id = ${s.carol}`;
      expect(await ids(s.id, { campaign: s.c2 })).toContain(s.carol);
      await sql`update campaign_enrollments set status = 'removed' where person_id = ${s.carol}`;
      expect(await ids(s.id, { campaign: s.c2 })).not.toContain(s.carol);
      expect(await ids(s.id, { campaign: "none" })).toContain(s.carol);
    });

    it("narrows by has email, has LinkedIn and do-not-contact", async () => {
      const s = await seed();
      expect(await ids(s.id, { hasEmail: true })).toEqual(sorted(s.alice, s.bob, s.dan, s.eve, s.frank));
      expect(await ids(s.id, { hasEmail: false })).toEqual([s.carol]);
      expect(await ids(s.id, { hasLinkedin: true })).toEqual(sorted(s.alice, s.carol, s.frank));
      expect(await ids(s.id, { hasLinkedin: false })).toEqual(sorted(s.bob, s.dan, s.eve));
      expect(await ids(s.id, { doNotContact: true })).toEqual([s.dan]);
      expect(await ids(s.id, { doNotContact: false })).toEqual(sorted(s.alice, s.bob, s.carol, s.eve, s.frank));
    });

    it("narrows by source kind or exact value", async () => {
      const s = await seed();
      expect(await ids(s.id, { source: "import" })).toEqual(sorted(s.alice, s.dan, s.eve, s.frank));
      expect(await ids(s.id, { source: "import:run1" })).toEqual(sorted(s.alice, s.eve, s.frank));
      expect(await ids(s.id, { source: "manual" })).toEqual([s.bob]);
      expect(await ids(s.id, { source: "grid" })).toEqual([s.carol]);
    });

    it("narrows by an inclusive created range in UTC", async () => {
      const s = await seed();
      expect(await ids(s.id, { createdFrom: "2024-03-10" })).toEqual(sorted(s.carol, s.dan, s.eve, s.frank));
      expect(await ids(s.id, { createdTo: "2024-02-10" })).toEqual(sorted(s.alice, s.bob));
      // Dan was created at 23:30 UTC on the last day of the range.
      expect(await ids(s.id, { createdFrom: "2024-04-10", createdTo: "2024-04-10" })).toEqual([s.dan]);
      expect(await ids(s.id, { createdFrom: "2024-04-11", createdTo: "2024-04-09" })).toEqual([]);
    });

    it("narrows by CRM category", async () => {
      const s = await seed();
      expect(await ids(s.id, { category: "interested" })).toEqual([s.bob]);
      expect(await ids(s.id, { category: "customer" })).toEqual([]);
    });

    it("narrows by an explicit id list", async () => {
      const s = await seed();
      expect(await ids(s.id, { ids: [s.alice, s.bob] })).toEqual(sorted(s.alice, s.bob));
    });
  });

  describe("filters combined", () => {
    it("applies every condition together", async () => {
      const s = await seed();
      expect(await ids(s.id, { hasEmail: true, source: "import", doNotContact: false })).toEqual(sorted(s.alice, s.eve, s.frank));
      expect(await ids(s.id, { hasEmail: true, source: "import", doNotContact: false, notInCampaign: s.c1 })).toEqual([s.frank]);
      expect(await ids(s.id, { query: "acme", hasLinkedin: true })).toEqual(sorted(s.alice, s.frank));
      expect(await ids(s.id, { query: "acme", hasLinkedin: true, notInCampaign: s.c1 })).toEqual([s.frank]);
      expect(await ids(s.id, { campaign: s.c1, createdFrom: "2024-05-01" })).toEqual([s.eve]);
      expect(await ids(s.id, { category: "interested", hasEmail: false })).toEqual([]);
    });

    it("counts what it lists", async () => {
      const s = await seed();
      const filter: LeadFilter = { hasEmail: true, campaign: "none" };
      expect(await uc.countLeads(deps, s.actor, filter)).toBe((await ids(s.id, filter)).length);
    });
  });

  describe("search", () => {
    it("finds a lead by LinkedIn slug, pasted profile URL and phone digits", async () => {
      const s = await seed();
      expect(await ids(s.id, { query: "carol-c" })).toEqual([s.carol]);
      expect(await ids(s.id, { query: "linkedin.com/in/alice-a" })).toEqual([s.alice]);
      expect(await ids(s.id, { query: "https://linkedin.com/in/Alice-A?utm_source=x" })).toEqual([s.alice]);
      expect(await ids(s.id, { query: "+1 (415) 555-0101" })).toEqual([s.alice]);
      expect(await ids(s.id, { query: "415 555" })).toEqual([s.alice]);
      expect(await ids(s.id, { query: "0101" })).toEqual([s.alice]);
    });

    it("keeps LIKE wildcards literal", async () => {
      const s = await seed();
      await person(s.id, { email: "pct@x.com", name: "Fifty 50% Off" });
      expect(await ids(s.id, { query: "50%" })).toHaveLength(1);
      expect(await ids(s.id, { query: "%" })).toHaveLength(1);
      expect(await ids(s.id, { query: "_" })).toEqual([]);
    });
  });

  describe("sort", () => {
    it("orders by every key in both directions, nulls last, with the id as tie-break", async () => {
      const s = await seed();
      const names = async (sort: LeadSort) => (await q.listLeads(s.id, { sort, pageSize: 200 })).rows.map((r) => r.fullName);
      expect(await names({ key: "name", dir: "asc" })).toEqual(["Alice Adams", "Bob Brown", "Carol Cruz", "Dan Diaz", "Eve Evans", "Frank Fox"]);
      expect(await names({ key: "name", dir: "desc" })).toEqual(["Frank Fox", "Eve Evans", "Dan Diaz", "Carol Cruz", "Bob Brown", "Alice Adams"]);
      expect(await names({ key: "created", dir: "asc" })).toEqual(["Alice Adams", "Bob Brown", "Carol Cruz", "Dan Diaz", "Eve Evans", "Frank Fox"]);
      expect(await names({ key: "created", dir: "desc" })).toEqual(["Frank Fox", "Eve Evans", "Dan Diaz", "Carol Cruz", "Bob Brown", "Alice Adams"]);
      // Company: Acme (alice, dan, frank) before Zeta (bob, eve); Carol has none and sorts last either way.
      const byCompany = (await q.listLeads(s.id, { sort: { key: "company", dir: "asc" }, pageSize: 200 })).rows;
      expect(byCompany.map((r) => r.companyName)).toEqual(["Acme", "Acme", "Acme", "Zeta", "Zeta", null]);
      const byCompanyDesc = (await q.listLeads(s.id, { sort: { key: "company", dir: "desc" }, pageSize: 200 })).rows;
      expect(byCompanyDesc.map((r) => r.companyName)).toEqual(["Zeta", "Zeta", "Acme", "Acme", "Acme", null]);
      // Email: Carol has none and sorts last.
      const byEmail = (await q.listLeads(s.id, { sort: { key: "email", dir: "asc" }, pageSize: 200 })).rows;
      expect(byEmail.map((r) => r.email)).toEqual(["alice@acme.com", "bob@zeta.io", "dan@acme.com", "eve@zeta.io", "frank@acme.com", null]);
      const byTitle = (await q.listLeads(s.id, { sort: { key: "title", dir: "asc" }, pageSize: 200 })).rows;
      expect(byTitle.slice(0, 2).map((r) => r.title)).toEqual(["CEO", "CTO"]);
      expect(byTitle.slice(2).every((r) => r.title === null)).toBe(true);
    });

    const KEYS: LeadSort["key"][] = ["name", "company", "title", "email", "created"];
    it("pages without gaps or repeats when every row ties on the sort value", async () => {
      const o = await org();
      // 60 rows with identical created_at, updated_at, name, title and company: only the id separates them.
      await sql`
        insert into people (organization_id, email, full_name, title, created_at, updated_at)
        select ${o.id}, null, 'Same Name', 'Same Title', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z' from generate_series(1, 60) g`;
      const [{ total }] = await sql`select count(*)::int as total from people where organization_id = ${o.id}`;
      for (const key of KEYS) {
        for (const dir of ["asc", "desc"] as const) {
          const seen: string[] = [];
          for (let page = 1; page <= 3; page += 1) {
            const result = await q.listLeads(o.id, { sort: { key, dir }, page, pageSize: 25 });
            seen.push(...result.rows.map((r) => r.id));
          }
          expect(seen, `${key} ${dir}`).toHaveLength(total);
          expect(new Set(seen).size, `${key} ${dir}`).toBe(total);
          // The tie-break follows the direction, so the id order is the same on every page.
          const expected = [...seen].sort();
          expect(seen, `${key} ${dir}`).toEqual(dir === "asc" ? expected : expected.reverse());
        }
      }
    });

    it("defaults to newest first", async () => {
      const s = await seed();
      const result = await q.listLeads(s.id, { pageSize: 200 });
      expect(result.rows[0].id).toBe(s.frank);
      expect(result.rows.at(-1)?.id).toBe(s.alice);
    });
  });

  describe("bulk actions", () => {
    it("refuses delete-all-matching with an empty filter and deletes nothing", async () => {
      const s = await seed();
      const total = await uc.countLeads(deps, s.actor, {});
      await expect(uc.deleteLeads(deps, s.actor, { filter: {}, confirmCount: total })).rejects.toBeInstanceOf(ValidationError);
      // A blank search and an id list are not filters for this action.
      await expect(uc.deleteLeads(deps, s.actor, { filter: { query: "   " }, confirmCount: total })).rejects.toBeInstanceOf(ValidationError);
      await expect(uc.deleteLeads(deps, s.actor, { filter: { ids: [s.alice] }, confirmCount: 1 })).rejects.toBeInstanceOf(ValidationError);
      expect(await uc.countLeads(deps, s.actor, {})).toBe(total);
    });

    it("deletes only the filtered set", async () => {
      const s = await seed();
      const filter: LeadFilter = { campaign: "none", hasEmail: true };
      const matching = await uc.countLeads(deps, s.actor, filter);
      expect(matching).toBe(2);
      const result = await uc.deleteLeads(deps, s.actor, { filter, confirmCount: matching });
      // Bob has a CRM record, so he stays and comes back as blocked.
      expect(result.deleted).toBe(1);
      expect(result.blocked.map((b) => b.id)).toEqual([s.bob]);
      expect(await ids(s.id, {})).toEqual(sorted(s.alice, s.bob, s.carol, s.eve, s.frank));
    });

    it("exports the filtered set and the selected ids only", async () => {
      const s = await seed();
      const filtered = await csvOf(s.actor, { campaign: "any", hasEmail: true });
      expect(filtered).toContain("alice@acme.com");
      expect(filtered).toContain("eve@zeta.io");
      expect(filtered).not.toContain("bob@zeta.io");
      expect(filtered).not.toContain("Carol");
      const selected = await csvOf(s.actor, { ids: [s.bob] });
      expect(selected).toContain("bob@zeta.io");
      expect(selected).not.toContain("alice@acme.com");
      // No filter still exports everything, as before.
      expect(await csvOf(s.actor, {})).toContain("frank@acme.com");
    });
  });

  describe("tenant isolation", () => {
    it("never returns, counts, exports or deletes another organization's leads", async () => {
      const a = await seed();
      const b = await seed();
      const idsOfA = new Set(a.all);
      for (const filter of [{}, { campaign: "any" }, { hasEmail: true }, { query: "acme" }, { source: "import" }] satisfies LeadFilter[]) {
        const rows = await ids(b.id, filter);
        expect(rows.some((id) => idsOfA.has(id))).toBe(false);
      }
      // B's list filtered by A's campaign id matches nothing.
      expect(await ids(b.id, { campaign: a.c1 })).toEqual([]);
      expect(await ids(b.id, { ids: a.all })).toEqual([]);
      expect(await uc.countLeads(deps, b.actor, { query: "acme" })).toBe(3);
      const exported = await csvOf(b.actor, { ids: a.all });
      expect(exported.split("\n").filter((line) => line.includes("@")).length).toBe(0);
      const result = await uc.deleteLeads(deps, b.actor, { filter: { query: "acme" }, confirmCount: 3 });
      expect(result.deleted).toBe(3);
      expect(await uc.countLeads(deps, a.actor, {})).toBe(6);
    });
  });

  // The Companies list moved to the CRM: its cases live in deals/infrastructure/crm-read.integration.test.ts.

  describe("lifecycle, Replied and hasConversation", () => {
    const toContact = async (personId: string) => {
      await sql`update people set lifecycle = 'contact', converted_at = '2026-10-01T10:00:00Z' where id = ${personId}`;
    };
    const replyTypeSetOf = async (orgId: string) => {
      const [{ id }] = await sql`insert into reply_type_sets (organization_id, name, is_default) values (${orgId}, 'default', true) returning id`;
      return id as string;
    };
    let msg = 0;
    /** A record, a conversation and one message for a person. `privateCampaignId` makes the thread private. */
    const thread = async (orgId: string, pipeline: string, personId: string, direction: "inbound" | "outbound", privateCampaignId: string | null = null) => {
      msg += 1;
      const [existing] = await sql`select id from records where organization_id = ${orgId} and person_id = ${personId}`;
      const recordId: string = existing?.id ?? (await sql`insert into records (organization_id, person_id, reply_type_set_id) values (${orgId}, ${personId}, ${pipeline}) returning id`)[0].id;
      const [{ id: conversationId }] = await sql`insert into conversations (organization_id, record_id, channel, account_ref, private_campaign_id) values (${orgId}, ${recordId}, 'email', ${"acct-" + msg}, ${privateCampaignId}) returning id`;
      await sql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
        values (${orgId}, ${conversationId}, 'email', ${"acct-" + msg}, ${direction}, ${"k" + msg + "-" + orgId}, 'hello', now())`;
    };

    async function seedLifecycle() {
      const o = await org();
      const lead1 = await person(o.id, { email: "zed1@x.test", name: "Zed One" });
      const lead2 = await person(o.id, { email: "zed2@x.test", name: "Zed Two" });
      const contact1 = await person(o.id, { email: "zed3@x.test", name: "Zed Three" });
      const contact2 = await person(o.id, { email: "zed4@x.test", name: "Zed Four" });
      await toContact(contact1);
      await toContact(contact2);
      return { ...o, lead1, lead2, contact1, contact2, leads: sorted(lead1, lead2), contacts: sorted(contact1, contact2) };
    }

    it("never lists a contact by default: list, count, ids, export and delete-matching, also with an empty filter", async () => {
      const w = await seedLifecycle();
      for (const filter of [{}, { query: "zed" }, { lifecycle: "lead" as const }]) {
        expect(await ids(w.id, filter), JSON.stringify(filter)).toEqual(w.leads);
        expect(await uc.countLeads(deps, w.actor, filter), JSON.stringify(filter)).toBe(2);
        const matching = await uc.listMatchingLeadIds(deps, w.actor, filter, 100);
        expect(sorted(...matching.ids), JSON.stringify(filter)).toEqual(w.leads);
        const csv = await csvOf(w.actor, filter);
        expect(csv).toContain("zed1@x.test");
        expect(csv).not.toContain("zed3@x.test");
        expect(csv).not.toContain("zed4@x.test");
      }
      // Ticked ids export exactly the selection: a contact ticked under lifecycle=all is in the file, an unticked one is not.
      const ticked = await csvOf(w.actor, { ids: [w.lead1, w.contact1] });
      expect(ticked).toContain("zed3@x.test");
      expect(ticked).not.toContain("zed4@x.test");
      expect(ticked).not.toContain("zed2@x.test");
      // Delete by filter sees leads only, so a contact is neither counted nor touched.
      const result = await uc.deleteLeads(deps, w.actor, { filter: { query: "zed" }, confirmCount: 2 });
      expect(result.deleted).toBe(2);
      expect(await ids(w.id, { lifecycle: "contact" })).toEqual(w.contacts);
    });

    it("lists both with lifecycle=all, only contacts with lifecycle=contact, and returns the lifecycle fields", async () => {
      const w = await seedLifecycle();
      expect(await ids(w.id, { lifecycle: "all" })).toEqual(sorted(w.lead1, w.lead2, w.contact1, w.contact2));
      expect(await ids(w.id, { lifecycle: "contact" })).toEqual(w.contacts);
      expect(await uc.countLeads(deps, w.actor, { lifecycle: "all" })).toBe(4);
      const rows = (await q.listLeads(w.id, { filter: { lifecycle: "all" }, pageSize: 200 })).rows;
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(w.lead1)).toMatchObject({ lifecycle: "lead", convertedAt: null });
      expect(byId.get(w.contact1)?.lifecycle).toBe("contact");
      expect(byId.get(w.contact1)?.convertedAt?.toISOString()).toBe("2026-10-01T10:00:00.000Z");
      // The detail carries the same fields.
      const detail = await uc.getLead(deps, w.actor, w.contact1);
      expect(detail.person).toMatchObject({ lifecycle: "contact" });
      expect(detail.person.convertedAt?.toISOString()).toBe("2026-10-01T10:00:00.000Z");
      expect((await uc.getLead(deps, w.actor, w.lead1)).person).toMatchObject({ lifecycle: "lead", convertedAt: null });
    });

    it("adds a Lifecycle column to the CSV export", async () => {
      const w = await seedLifecycle();
      const csv = await csvOf(w.actor, { lifecycle: "all" });
      const [header, ...lines] = csv.slice(1).trimEnd().split("\r\n");
      const column = header.split(",").indexOf("Lifecycle");
      expect(column).toBeGreaterThan(-1);
      const byEmail = new Map(lines.map((line) => [line.split(",")[3], line.split(",")[column]]));
      expect(byEmail.get("zed1@x.test")).toBe("lead");
      expect(byEmail.get("zed3@x.test")).toBe("contact");
    });

    it("keeps lifecycle scoped to the organization", async () => {
      const a = await seedLifecycle();
      const b = await org();
      await person(b.id, { email: "other@x.test" });
      expect(await ids(b.id, { lifecycle: "contact" })).toEqual([]);
      expect(await ids(a.id, { lifecycle: "all" })).toHaveLength(4);
    });

    it("defines Replied as a replied enrollment or an inbound public message, in the filter and in the lead status alike", async () => {
      const o = await org();
      const pipeline = await replyTypeSetOf(o.id);
      const regular = await campaign(o.id, "email", "Regular");
      const [{ id: personalCampaign }] = await sql`insert into campaigns (organization_id, channel, name, status, type) values (${o.id}, 'linkedin', 'Private', 'active', 'personal') returning id`;
      const unknownSender = await person(o.id, { email: "u@x.test" });
      const enrolledReplied = await person(o.id, { email: "e@x.test" });
      const outboundOnly = await person(o.id, { email: "o@x.test" });
      const privateInbound = await person(o.id, { email: "p@x.test" });
      const quiet = await person(o.id, { email: "q@x.test" });
      await thread(o.id, pipeline, unknownSender, "inbound");
      await enroll(o.id, regular, enrolledReplied, "email", "replied");
      await thread(o.id, pipeline, outboundOnly, "outbound");
      await thread(o.id, pipeline, privateInbound, "inbound", personalCampaign);
      const repliers = sorted(unknownSender, enrolledReplied);
      const others = sorted(outboundOnly, privateInbound, quiet);

      expect(await ids(o.id, { replied: true })).toEqual(repliers);
      expect(await ids(o.id, { replied: false })).toEqual(others);

      // The lead status of the list and the lead page (one read for both) follows the same definition.
      const statuses = await readLeadStatuses(o.id, [...repliers, ...others]);
      for (const personId of repliers) expect(statuses.get(personId)?.state, personId).toBe("replied");
      for (const personId of others) expect(statuses.get(personId)?.state ?? "new", personId).not.toBe("replied");
    });

    it("filters by hasConversation: a record with a public conversation counts, a private-only or record-only person does not", async () => {
      const o = await org();
      const pipeline = await replyTypeSetOf(o.id);
      const [{ id: personalCampaign }] = await sql`insert into campaigns (organization_id, channel, name, status, type) values (${o.id}, 'linkedin', 'Private', 'active', 'personal') returning id`;
      const outbound = await person(o.id, { email: "a@x.test" });
      const inbound = await person(o.id, { email: "b@x.test" });
      const privateOnly = await person(o.id, { email: "c@x.test" });
      const recordOnly = await person(o.id, { email: "d@x.test" });
      const none = await person(o.id, { email: "e@x.test" });
      await thread(o.id, pipeline, outbound, "outbound");
      await thread(o.id, pipeline, inbound, "inbound");
      await thread(o.id, pipeline, privateOnly, "outbound", personalCampaign);
      await sql`insert into records (organization_id, person_id, reply_type_set_id) values (${o.id}, ${recordOnly}, ${pipeline})`;
      expect(await ids(o.id, { hasConversation: true })).toEqual(sorted(outbound, inbound));
      expect(await ids(o.id, { hasConversation: false })).toEqual(sorted(privateOnly, recordOnly, none));
      expect(await ids(o.id, { hasConversation: true, lifecycle: "contact" })).toEqual([]);
    });
  });

  describe("last contact", () => {
    let msg = 0;
    const replyTypeSetOf = async (orgId: string) => {
      const [{ id }] = await sql`insert into reply_type_sets (organization_id, name, is_default) values (${orgId}, 'default', true) returning id`;
      return id as string;
    };
    /** One outbound or inbound message on the person's record, in the conversation of that channel. */
    const message = async (orgId: string, pipeline: string, personId: string, channel: "email" | "linkedin", direction: "inbound" | "outbound", sentAt: string) => {
      msg += 1;
      const [existing] = await sql`select id from records where organization_id = ${orgId} and person_id = ${personId}`;
      const recordId: string = existing?.id ?? (await sql`insert into records (organization_id, person_id, reply_type_set_id) values (${orgId}, ${personId}, ${pipeline}) returning id`)[0].id;
      const account = `${channel}-acct-${orgId}`;
      const [conv] = await sql`select id from conversations where record_id = ${recordId} and channel = ${channel} and private_campaign_id is null`;
      const conversationId =
        conv?.id ?? (await sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${orgId}, ${recordId}, ${channel}, ${account}) returning id`)[0].id;
      await sql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
        values (${orgId}, ${conversationId}, ${channel}, ${account}, ${direction}, ${`lc${msg}-${orgId}`}, 'hello', ${sentAt})`;
    };
    const lead = (orgId: string) => person(orgId, { email: `lc${++msg}@x.test` });

    it("filters on last contact from and to, and excludes leads never contacted", async () => {
      const o = await org();
      const pipeline = await replyTypeSetOf(o.id);
      const old = await lead(o.id);
      const recent = await lead(o.id);
      const mixed = await lead(o.id);
      // A lead without any message matches no last-contact bound.
      await lead(o.id);
      await message(o.id, pipeline, old, "email", "outbound", "2026-08-15T10:00:00Z");
      await message(o.id, pipeline, recent, "linkedin", "outbound", "2026-10-10T10:00:00Z");
      await message(o.id, pipeline, mixed, "email", "outbound", "2026-08-20T10:00:00Z");
      await message(o.id, pipeline, mixed, "linkedin", "outbound", "2026-10-12T10:00:00Z");
      expect(await ids(o.id, { lastContactFrom: "2026-10-01" })).toEqual(sorted(recent, mixed));
      // "To" means the latest contact is on or before the day, so a lead contacted again later drops out.
      expect(await ids(o.id, { lastContactTo: "2026-09-30" })).toEqual([old]);
      expect(await ids(o.id, { lastContactTo: "2026-08-15" })).toEqual([old]);
      expect(await ids(o.id, { lastContactTo: "2026-08-14" })).toEqual([]);
      expect(await ids(o.id, { lastContactFrom: "2026-08-01", lastContactTo: "2026-08-31" })).toEqual([old]);
    });

    it("matches both bounds against the one latest contact", async () => {
      const o = await org();
      const pipeline = await replyTypeSetOf(o.id);
      const inside = await lead(o.id);
      const straddler = await lead(o.id);
      const edgeEnd = await lead(o.id);
      const edgeNext = await lead(o.id);
      const inboundOnly = await lead(o.id);
      await message(o.id, pipeline, inside, "email", "outbound", "2026-08-05T10:00:00Z");
      await message(o.id, pipeline, inside, "linkedin", "outbound", "2026-08-20T10:00:00Z");
      // Contacted once before the range and once after it: the latest contact is outside, so neither bound pair keeps it.
      await message(o.id, pipeline, straddler, "email", "outbound", "2026-07-10T10:00:00Z");
      await message(o.id, pipeline, straddler, "email", "outbound", "2026-10-12T10:00:00Z");
      await message(o.id, pipeline, edgeEnd, "email", "outbound", "2026-08-31T23:59:59Z");
      await message(o.id, pipeline, edgeNext, "email", "outbound", "2026-09-01T00:00:00Z");
      // Inbound mail never counts as contact.
      await message(o.id, pipeline, inboundOnly, "email", "inbound", "2026-08-15T10:00:00Z");
      expect(await ids(o.id, { lastContactFrom: "2026-08-01", lastContactTo: "2026-08-31" })).toEqual(sorted(inside, edgeEnd));
      expect(await ids(o.id, { lastContactFrom: "2026-09-01", lastContactTo: "2026-09-01" })).toEqual([edgeNext]);
      expect(await ids(o.id, { lastContactFrom: "2026-07-01", lastContactTo: "2026-07-31" })).toEqual([]);
      // Each bound alone still sees the straddler through its latest contact only.
      expect(await ids(o.id, { lastContactTo: "2026-09-30" })).toEqual(sorted(inside, edgeEnd, edgeNext));
      expect(await ids(o.id, { lastContactFrom: "2026-10-01" })).toEqual([straddler]);
    });

    it("counts a cold campaign send as last contact, and a private campaign send not at all", async () => {
      const o = await org();
      const regular = await campaign(o.id, "email", "Alpha");
      const [{ id: personal }] = await sql`insert into campaigns (organization_id, channel, name, status, type) values (${o.id}, 'linkedin', 'Private', 'active', 'personal') returning id`;
      const cold = await lead(o.id);
      const privateOnly = await lead(o.id);
      await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, last_sent_at)
        values (${o.id}, ${regular}, ${cold}, 'email', 'active', '2026-10-03T10:00:00Z'), (${o.id}, ${personal}, ${privateOnly}, 'email', 'active', '2026-10-03T10:00:00Z')`;
      expect(await ids(o.id, { lastContactFrom: "2026-10-01" })).toEqual([cold]);
      expect(await ids(o.id, { lastContactTo: "2026-10-03" })).toEqual([cold]);
      expect(await ids(o.id, { lastContactTo: "2026-10-02" })).toEqual([]);
    });
  });

  describe("activity reads agree", () => {
    let n = 0;
    const replyTypeSetOf = async (orgId: string) => {
      const [{ id }] = await sql`insert into reply_type_sets (organization_id, name, is_default) values (${orgId}, 'default', true) returning id`;
      return id as string;
    };
    /** One message on the person's record, in a public thread or, with `privateCampaignId`, a personal campaign's private thread. */
    const message = async (orgId: string, pipeline: string, personId: string, direction: "inbound" | "outbound", sentAt: string, privateCampaignId: string | null = null) => {
      n += 1;
      const [existing] = await sql`select id from records where organization_id = ${orgId} and person_id = ${personId}`;
      const recordId: string = existing?.id ?? (await sql`insert into records (organization_id, person_id, reply_type_set_id) values (${orgId}, ${personId}, ${pipeline}) returning id`)[0].id;
      const [{ id: conversationId }] = await sql`insert into conversations (organization_id, record_id, channel, account_ref, private_campaign_id)
        values (${orgId}, ${recordId}, 'email', ${`ar${n}`}, ${privateCampaignId}) returning id`;
      await sql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
        values (${orgId}, ${conversationId}, 'email', ${`ar${n}`}, ${direction}, ${`ar${n}-${orgId}`}, 'hello', ${sentAt})`;
    };
    const enrollSent = async (orgId: string, campaignId: string, personId: string, status: string, lastSentAt: string | null) => {
      await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, last_sent_at)
        select ${orgId}, id, ${personId}, channel, ${status}, ${lastSentAt} from campaigns where id = ${campaignId}`;
    };
    const personal = async (orgId: string) => {
      const [{ id }] = await sql`insert into campaigns (organization_id, channel, name, status, type) values (${orgId}, 'linkedin', 'Private', 'active', 'personal') returning id`;
      return id as string;
    };
    const lead = (orgId: string) => person(orgId, { email: `ar${++n}@x.test` });
    const dayOf = (at: Date) => at.toISOString().slice(0, 10);
    const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

    it("puts the lead status's last contact inside the list's last-contact range on the same UTC day", async () => {
      const o = await org();
      const pipeline = await replyTypeSetOf(o.id);
      const regular = await campaign(o.id, "email", "Regular");
      const other = await campaign(o.id, "email", "Other");
      const privateCampaign = await personal(o.id);
      // A campaign step later than every message: the step is the last contact.
      const stepLater = await lead(o.id);
      await message(o.id, pipeline, stepLater, "outbound", "2026-09-01T10:00:00Z");
      await enrollSent(o.id, regular, stepLater, "active", "2026-09-20T23:30:00Z");
      // A removed enrollment's step went out, so it stays contact.
      const removed = await lead(o.id);
      await enrollSent(o.id, other, removed, "removed", "2026-08-15T00:10:00Z");
      // A personal campaign's step is private, so the public message decides.
      const personalStep = await lead(o.id);
      await message(o.id, pipeline, personalStep, "outbound", "2026-06-01T08:00:00Z");
      await enrollSent(o.id, privateCampaign, personalStep, "active", "2026-10-01T10:00:00Z");
      // An outbound message in a private thread never counts.
      const privateThread = await lead(o.id);
      await message(o.id, pipeline, privateThread, "outbound", "2026-05-05T12:00:00Z");
      await message(o.id, pipeline, privateThread, "outbound", "2026-10-05T12:00:00Z", privateCampaign);
      const expected = new Map([
        [stepLater, "2026-09-20"],
        [removed, "2026-08-15"],
        [personalStep, "2026-06-01"],
        [privateThread, "2026-05-05"],
      ]);

      const statuses = await readLeadStatuses(o.id, [...expected.keys()]);
      for (const [personId, day] of expected) {
        const at = statuses.get(personId)?.lastContactAt;
        expect(at && dayOf(at), personId).toBe(day);
        expect(await ids(o.id, { lastContactFrom: day, lastContactTo: day }), day).toContain(personId);
        expect(await ids(o.id, { lastContactTo: shift(day, -1) }), day).not.toContain(personId);
        expect(await ids(o.id, { lastContactFrom: shift(day, 1) }), day).not.toContain(personId);
      }
    });

    it("leaves a lead contacted only in private out of both the status and the range", async () => {
      const o = await org();
      const pipeline = await replyTypeSetOf(o.id);
      const privateCampaign = await personal(o.id);
      const hidden = await lead(o.id);
      await enrollSent(o.id, privateCampaign, hidden, "active", "2026-10-01T10:00:00Z");
      await message(o.id, pipeline, hidden, "outbound", "2026-10-02T10:00:00Z", privateCampaign);
      expect((await readLeadStatuses(o.id, [hidden])).get(hidden)?.lastContactAt ?? null).toBeNull();
      expect(await ids(o.id, { lastContactFrom: "2000-01-01" })).toEqual([]);
    });

    it("gives count, matching ids, export, delete by filter and previous/next the list's set for every activity filter", async () => {
      const o = await org();
      const pipeline = await replyTypeSetOf(o.id);
      const c1 = await campaign(o.id, "email", "One");
      const c2 = await campaign(o.id, "email", "Two");
      const privateCampaign = await personal(o.id);
      const active = await lead(o.id);
      await enrollSent(o.id, c1, active, "active", null);
      await message(o.id, pipeline, active, "outbound", "2026-08-10T10:00:00Z");
      await sql`update records set group_key = 'interested', reply_type_source = 'human' where person_id = ${active}`;
      const replied = await lead(o.id);
      await enrollSent(o.id, c1, replied, "replied", "2026-09-05T10:00:00Z");
      const removed = await lead(o.id);
      await enrollSent(o.id, c2, removed, "removed", "2026-07-01T10:00:00Z");
      const privateOnly = await lead(o.id);
      await enrollSent(o.id, privateCampaign, privateOnly, "active", "2026-08-12T10:00:00Z");
      await message(o.id, pipeline, privateOnly, "inbound", "2026-08-13T10:00:00Z", privateCampaign);
      const wroteIn = await lead(o.id);
      await message(o.id, pipeline, wroteIn, "inbound", "2026-08-20T10:00:00Z");
      const pending = await lead(o.id);
      await enrollSent(o.id, c2, pending, "pending", null);
      await sql`insert into records (organization_id, person_id, reply_type_set_id, group_key, reply_type_source) values (${o.id}, ${pending}, ${pipeline}, 'customer', 'human')`;
      await lead(o.id);

      const filters: LeadFilter[] = [
        { replied: true },
        { replied: false },
        { campaign: "any" },
        { campaign: "none" },
        { campaign: c1 },
        { notInCampaign: c1 },
        { hasConversation: true },
        { hasConversation: false },
        { lastContactFrom: "2026-08-01" },
        { lastContactTo: "2026-08-31" },
        { lastContactFrom: "2026-07-01", lastContactTo: "2026-08-31" },
        { category: "interested" },
        { category: "customer", campaign: "any" },
        { replied: false, hasConversation: true, lastContactFrom: "2026-08-01" },
      ];
      for (const filter of filters) {
        const label = JSON.stringify(filter);
        const list = (await q.listLeads(o.id, { filter, pageSize: 200 })).rows.map((r) => r.id);
        expect(list.length, label).toBeGreaterThan(0);
        expect(await uc.countLeads(deps, o.actor, filter), label).toBe(list.length);
        expect(sorted(...(await uc.listMatchingLeadIds(deps, o.actor, filter, 100)).ids), label).toEqual(sorted(...list));
        expect(sorted(...(await deps.people.idsMatching(o.id, filter))), label).toEqual(sorted(...list));
        const exported: string[] = [];
        for await (const batch of deps.leads.exportBatches(o.id, filter)) exported.push(...batch.map((row) => row.email ?? ""));
        const emailOf = new Map((await q.listLeads(o.id, { filter, pageSize: 200 })).rows.map((r) => [r.id, r.email ?? ""]));
        expect(sorted(...exported), label).toEqual(sorted(...list.map((id) => emailOf.get(id) ?? "")));
        for (const [i, id] of list.entries()) {
          expect(await readLeadNeighbors(o.id, id, { filter, sort: DEFAULT_LEAD_SORT }), `${label} ${i}`).toEqual({ prevId: list[i - 1] ?? null, nextId: list[i + 1] ?? null });
        }
      }
    });
  });
});
