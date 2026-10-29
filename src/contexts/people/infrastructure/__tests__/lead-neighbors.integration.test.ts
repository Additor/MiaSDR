import { afterAll, beforeAll, expect, it } from "vitest";
import { LEAD_SORT_KEYS, type LeadFilter, type LeadSort } from "../../domain/lead-filter";
import { describeDb, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("lead page neighbors", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let neighbors: typeof import("@/composition/leads");
  let q: typeof import("@/composition/leads");
  const orgs: string[] = [];

  async function org() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id }] = await sql`insert into organizations (name, slug) values ('N', ${"ln-" + tag}) returning id`;
    orgs.push(id);
    return { id: id as string, tag };
  }
  type Org = Awaited<ReturnType<typeof org>>;

  let counter = 0;
  async function company(o: Org, domain: string, name: string | null) {
    const [{ id }] = await sql`insert into companies (organization_id, domain, name) values (${o.id}, ${domain + "-" + o.tag + ".test"}, ${name}) returning id`;
    return id as string;
  }
  async function person(o: Org, p: { name: string | null; title?: string | null; email?: string | null; companyId?: string | null; createdAt: string }) {
    counter += 1;
    const [{ id }] = await sql`
      insert into people (organization_id, full_name, title, email, linkedin_slug, company_id, created_at, updated_at)
      values (${o.id}, ${p.name}, ${p.title ?? null}, ${p.email === undefined ? `n${counter}-${o.tag}@ln.test` : p.email}, ${`ln-${counter}-${o.tag}`}, ${p.companyId ?? null}, ${p.createdAt}, ${p.createdAt}) returning id`;
    return id as string;
  }

  /** The list's own order for a filter and a sort: the truth the neighbors must agree with. */
  const listOrder = async (orgId: string, filter: LeadFilter, sort: LeadSort) => (await q.listLeads(orgId, { filter, sort, pageSize: 200 })).rows.map((r) => r.id);

  beforeAll(async () => {
    neighbors = await import("@/composition/leads");
    q = neighbors;
  });

  afterAll(async () => {
    for (const id of orgs) await sql`delete from organizations where id = ${id}`;
    await sql.end();
  });

  async function seedMixed() {
    const o = await org();
    const acme = await company(o, "acme", "Acme");
    const zeta = await company(o, "zeta", null);
    const day = (n: number) => `2024-03-${String(n).padStart(2, "0")}T10:00:00Z`;
    const ids = [
      await person(o, { name: "Ada Lovelace", title: "CTO", email: "ada@x.test", companyId: acme, createdAt: day(1) }),
      await person(o, { name: "ada lovelace", title: "cto", email: "ADA2@x.test", companyId: zeta, createdAt: day(2) }),
      await person(o, { name: "Bob", title: null, email: "bob@x.test", companyId: null, createdAt: day(3) }),
      await person(o, { name: null, title: "Engineer", email: "nobody@x.test", companyId: acme, createdAt: day(4) }),
      await person(o, { name: "Cy", title: "Engineer", email: null, companyId: zeta, createdAt: day(5) }),
      await person(o, { name: null, title: null, email: "n2@x.test", companyId: null, createdAt: day(5) }),
      await person(o, { name: "Dee", title: "Engineer", email: "dee@x.test", companyId: acme, createdAt: day(5) }),
      await person(o, { name: "Dee", title: "Engineer", email: "dee2@x.test", companyId: acme, createdAt: day(5) }),
    ];
    return { o, ids };
  }

  for (const key of LEAD_SORT_KEYS) {
    for (const dir of ["asc", "desc"] as const) {
      it(`agrees with the list order for sort ${key} ${dir}, nulls, ties and case included`, async () => {
        const { o, ids } = await seedMixed();
        const sort: LeadSort = { key, dir };
        const order = await listOrder(o.id, {}, sort);
        expect(order).toHaveLength(ids.length);
        for (let i = 0; i < order.length; i++) {
          const got = await neighbors.readLeadNeighbors(o.id, order[i], { filter: {}, sort });
          expect(got, `position ${i}`).toEqual({ prevId: order[i - 1] ?? null, nextId: order[i + 1] ?? null });
        }
      });
    }
  }

  it("follows the filter: neighbors come from the filtered list only", async () => {
    const { o } = await seedMixed();
    const filter: LeadFilter = { query: "engineer" };
    const sort: LeadSort = { key: "name", dir: "asc" };
    const order = await listOrder(o.id, filter, sort);
    expect(order.length).toBeGreaterThan(2);
    expect(order.length).toBeLessThan(8);
    for (let i = 0; i < order.length; i++) {
      expect(await neighbors.readLeadNeighbors(o.id, order[i], { filter, sort })).toEqual({ prevId: order[i - 1] ?? null, nextId: order[i + 1] ?? null });
    }
  });

  it("places a lead that no longer matches the filter between its filtered neighbors", async () => {
    const { o, ids } = await seedMixed();
    const filter: LeadFilter = { hasEmail: true };
    const sort: LeadSort = { key: "created", dir: "asc" };
    // Cy has no email, so it is outside the filter. Its neighbors are the matching rows around it.
    const cy = ids[4];
    const got = await neighbors.readLeadNeighbors(o.id, cy, { filter, sort });
    const full = await listOrder(o.id, {}, sort);
    const matching = new Set(await listOrder(o.id, filter, sort));
    const at = full.indexOf(cy);
    expect(got.prevId).toBe([...full.slice(0, at)].reverse().find((id) => matching.has(id)) ?? null);
    expect(got.nextId).toBe(full.slice(at + 1).find((id) => matching.has(id)) ?? null);
  });

  it("skips contacts unless the filter lists them", async () => {
    const o = await org();
    const sort: LeadSort = { key: "created", dir: "asc" };
    const one = await person(o, { name: "A", createdAt: "2024-01-01T00:00:00Z" });
    const contact = await person(o, { name: "B", createdAt: "2024-01-02T00:00:00Z" });
    const three = await person(o, { name: "C", createdAt: "2024-01-03T00:00:00Z" });
    await sql`update people set lifecycle = 'contact', converted_at = now() where id = ${contact}`;
    // The default filter, also an empty one: the contact is no neighbor of either lead.
    expect(await neighbors.readLeadNeighbors(o.id, one, { filter: {}, sort })).toEqual({ prevId: null, nextId: three });
    expect(await neighbors.readLeadNeighbors(o.id, three, { filter: {}, sort })).toEqual({ prevId: one, nextId: null });
    // lifecycle=all brings it back, and lifecycle=contact lists contacts only.
    expect(await neighbors.readLeadNeighbors(o.id, one, { filter: { lifecycle: "all" }, sort })).toEqual({ prevId: null, nextId: contact });
    expect(await neighbors.readLeadNeighbors(o.id, contact, { filter: { lifecycle: "contact" }, sort })).toEqual({ prevId: null, nextId: null });
  });

  it("returns null on the ends of the list and for the only lead", async () => {
    const o = await org();
    const only = await person(o, { name: "Solo", createdAt: "2024-01-01T00:00:00Z" });
    expect(await neighbors.readLeadNeighbors(o.id, only, { filter: {}, sort: { key: "name", dir: "asc" } })).toEqual({ prevId: null, nextId: null });
    const second = await person(o, { name: "Zed", createdAt: "2024-01-02T00:00:00Z" });
    expect(await neighbors.readLeadNeighbors(o.id, only, { filter: {}, sort: { key: "name", dir: "asc" } })).toEqual({ prevId: null, nextId: second });
    expect(await neighbors.readLeadNeighbors(o.id, second, { filter: {}, sort: { key: "name", dir: "asc" } })).toEqual({ prevId: only, nextId: null });
  });

  it("never reaches into another organization", async () => {
    const a = await org();
    const b = await org();
    const mine = await person(a, { name: "Mine", createdAt: "2024-01-01T00:00:00Z" });
    const theirs = await person(b, { name: "Mine too", createdAt: "2024-01-01T00:00:01Z" });
    const sort: LeadSort = { key: "created", dir: "asc" };
    expect(await neighbors.readLeadNeighbors(a.id, mine, { filter: {}, sort })).toEqual({ prevId: null, nextId: null });
    // An id from another organization finds no position at all.
    expect(await neighbors.readLeadNeighbors(a.id, theirs, { filter: {}, sort })).toEqual({ prevId: null, nextId: null });
    expect(await neighbors.readLeadNeighbors(b.id, theirs, { filter: {}, sort })).toEqual({ prevId: null, nextId: null });
  });

  it("skips a neighbor that was deleted and answers nothing for a deleted lead", async () => {
    const o = await org();
    const one = await person(o, { name: "A", createdAt: "2024-01-01T00:00:00Z" });
    const two = await person(o, { name: "B", createdAt: "2024-01-02T00:00:00Z" });
    const three = await person(o, { name: "C", createdAt: "2024-01-03T00:00:00Z" });
    const sort: LeadSort = { key: "created", dir: "asc" };
    await sql`delete from people where id = ${two}`;
    expect(await neighbors.readLeadNeighbors(o.id, one, { filter: {}, sort })).toEqual({ prevId: null, nextId: three });
    expect(await neighbors.readLeadNeighbors(o.id, three, { filter: {}, sort })).toEqual({ prevId: one, nextId: null });
    expect(await neighbors.readLeadNeighbors(o.id, two, { filter: {}, sort })).toEqual({ prevId: null, nextId: null });
  });
});
