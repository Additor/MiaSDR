import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("lead lifecycle store and people directory", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let lifecycle: typeof import("../drizzle-lead-lifecycle");
  let directory: typeof import("../people-directory");
  let convert: typeof import("../../application/convert-to-contact");
  let dbClient: typeof import("@/platform/db/client");
  const orgs: string[] = [];

  async function org() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id }] = await sql`insert into organizations (name, slug) values ('L', ${"ll-" + tag}) returning id`;
    orgs.push(id);
    return { id: id as string, tag };
  }
  type Org = Awaited<ReturnType<typeof org>>;
  let counter = 0;
  const person = async (o: Org, p: { name?: string | null; email?: string | null; companyId?: string | null; title?: string } = {}) => {
    counter += 1;
    const [{ id }] = await sql`
      insert into people (organization_id, full_name, email, title, company_id)
      values (${o.id}, ${p.name === undefined ? `Person ${counter}` : p.name}, ${p.email === undefined ? `p${counter}-${o.tag}@ll.test` : p.email}, ${p.title ?? null}, ${p.companyId ?? null}) returning id`;
    return id as string;
  };
  const state = async (personId: string) => {
    const [row] = await sql`select lifecycle, converted_at from people where id = ${personId}`;
    return { lifecycle: row.lifecycle as string, convertedAt: row.converted_at ? new Date(row.converted_at).toISOString() : null };
  };

  beforeAll(async () => {
    lifecycle = await import("../drizzle-lead-lifecycle");
    directory = await import("../people-directory");
    convert = await import("../../application/convert-to-contact");
    dbClient = await import("@/platform/db/client");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })));
    await sql.end();
  });

  describe("markConverted", () => {
    it("sets lifecycle and converted_at in one update and reports the change once", async () => {
      const o = await org();
      const p = await person(o);
      const at = new Date("2026-10-16T09:00:00Z");
      expect(await dbClient.db.transaction((tx) => lifecycle.markConverted(tx, o.id, p, at))).toBe(true);
      expect(await state(p)).toEqual({ lifecycle: "contact", convertedAt: "2026-10-16T09:00:00.000Z" });
      // A second call changes no row and keeps the first time (the people trigger would refuse a different one).
      expect(await dbClient.db.transaction((tx) => lifecycle.markConverted(tx, o.id, p, new Date("2026-11-01T00:00:00Z")))).toBe(false);
      expect(await state(p)).toEqual({ lifecycle: "contact", convertedAt: "2026-10-16T09:00:00.000Z" });
    });

    it("changes only the named person in the named organization", async () => {
      const a = await org();
      const b = await org();
      const mine = await person(a);
      const sibling = await person(a);
      const theirs = await person(b);
      expect(await dbClient.db.transaction((tx) => lifecycle.markConverted(tx, a.id, theirs, new Date()))).toBe(false);
      expect(await dbClient.db.transaction((tx) => lifecycle.markConverted(tx, a.id, "00000000-0000-4000-8000-000000000001", new Date()))).toBe(false);
      expect((await state(theirs)).lifecycle).toBe("lead");
      await dbClient.db.transaction((tx) => lifecycle.markConverted(tx, a.id, mine, new Date()));
      expect((await state(sibling)).lifecycle).toBe("lead");
    });

    it("reads the lifecycle for the use case, with the organization", async () => {
      const a = await org();
      const b = await org();
      const lead = await person(a);
      const contact = await person(a);
      await dbClient.db.transaction((tx) => lifecycle.markConverted(tx, a.id, contact, new Date()));
      const store = lifecycle.drizzleLeadLifecycle;
      await dbClient.db.transaction(async (tx) => {
        expect(await store.lifecycleOf(tx, a.id, lead)).toBe("lead");
        expect(await store.lifecycleOf(tx, a.id, contact)).toBe("contact");
        expect(await store.lifecycleOf(tx, b.id, lead)).toBeNull();
      });
      const map = await store.lifecycles(a.id, [lead, contact, "00000000-0000-4000-8000-000000000001"]);
      expect([...map]).toEqual(expect.arrayContaining([[lead, "lead"], [contact, "contact"]]));
      expect(map.size).toBe(2);
      expect((await store.lifecycles(b.id, [lead, contact])).size).toBe(0);
    });

    it("converts a person twice through the use case and changes one row once", async () => {
      const o = await org();
      const p = await person(o);
      const calls: string[] = [];
      const deps: import("../../application/convert-to-contact").ConvertDeps = {
        lockPerson: async () => void calls.push("lock"),
        lifecycleOf: lifecycle.drizzleLeadLifecycle.lifecycleOf,
        markConverted: lifecycle.markConverted,
        stopEnrollments: async () => ({ stopped: 0 }),
        interruptRuns: async () => ({ runs: 0, drafts: 0 }),
        appendEvent: async () => void calls.push("event"),
      };
      const run = () => dbClient.db.transaction((tx) => convert.convertToContact(deps, tx, { organizationId: o.id, personId: p, reason: "test", actorUserId: null }));
      expect((await run()).changed).toBe(true);
      const first = await state(p);
      expect((await run()).changed).toBe(false);
      expect(await state(p)).toEqual(first);
      expect(calls).toEqual(["lock", "event", "lock"]);
    });
  });

  describe("personSummaries", () => {
    it("returns the person, the company, the lifecycle and the flags, for the organization only", async () => {
      const a = await org();
      const b = await org();
      const [{ id: company }] = await sql`insert into companies (organization_id, domain, name) values (${a.id}, 'acme.test', 'Acme') returning id`;
      const ada = await person(a, { name: "Ada", email: "ada@acme.test", companyId: company, title: "CTO" });
      const noName = await person(a, { name: null, email: "anon@acme.test" });
      const theirs = await person(b, { name: "Theirs" });
      await dbClient.db.transaction((tx) => lifecycle.markConverted(tx, a.id, ada, new Date("2026-10-01T00:00:00Z")));
      await sql`insert into contact_policies (organization_id, person_id, do_not_contact, reason, source, set_at) values (${a.id}, ${ada}, true, 'asked', 'human', now())`;
      await sql`insert into suppression_list (organization_id, email, reason) values (${a.id}, 'anon@acme.test', 'manual')`;

      const map = await directory.personSummaries(a.id, [ada, noName, theirs, ada]);
      expect([...map.keys()].sort()).toEqual([ada, noName].sort());
      expect(map.get(ada)).toMatchObject({ name: "Ada", email: "ada@acme.test", title: "CTO", companyName: "Acme", companyDomain: "acme.test", lifecycle: "contact", doNotContact: true, suppressed: false });
      expect(map.get(ada)?.convertedAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
      expect(map.get(noName)).toMatchObject({ name: "anon@acme.test", lifecycle: "lead", convertedAt: null, doNotContact: false, suppressed: true, companyName: null });
      expect((await directory.personSummaries(b.id, [ada])).size).toBe(0);
      expect((await directory.personSummaries(a.id, [])).size).toBe(0);
    });
  });

  describe("searchPeople", () => {
    it("finds leads and contacts alike, at most 20, in name order, inside the organization", async () => {
      const a = await org();
      const b = await org();
      const [{ id: company }] = await sql`insert into companies (organization_id, domain, name) values (${a.id}, 'zorg.test', 'Zorg Industries') returning id`;
      const lead = await person(a, { name: "Mira Lead", email: "mira@zorg.test", companyId: company });
      const contact = await person(a, { name: "Alan Contact", email: "alan@zorg.test", companyId: company });
      await dbClient.db.transaction((tx) => lifecycle.markConverted(tx, a.id, contact, new Date()));
      await person(a, { name: "Unrelated", email: "x@else.test" });
      await person(b, { name: "Mira Other", email: "mira@zorg.test" });
      const actor = { organizationId: a.id };

      const rows = await directory.searchPeople(actor, "zorg");
      expect(rows).toEqual([
        { personId: contact, name: "Alan Contact", email: "alan@zorg.test", company: "Zorg Industries", lifecycle: "contact" },
        { personId: lead, name: "Mira Lead", email: "mira@zorg.test", company: "Zorg Industries", lifecycle: "lead" },
      ]);
      expect(await directory.searchPeople(actor, "")).toEqual([]);
      expect(await directory.searchPeople(actor, "   ")).toEqual([]);
      expect(await directory.searchPeople(actor, "%")).toEqual([]);
      expect(await directory.searchPeople({ organizationId: b.id }, "zorg")).toHaveLength(1);

      for (let i = 0; i < 25; i += 1) await person(a, { name: `Many ${String(i).padStart(2, "0")}`, email: `many${i}@many.test` });
      const many = await directory.searchPeople(actor, "many.test");
      expect(many).toHaveLength(20);
      expect(many.map((r) => r.name)).toEqual([...many.map((r) => r.name)].sort());
    });
  });
});
