import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("lead management", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let uc: typeof import("../../application/lead-management");
  let deps: import("../../application/lead-ports").LeadDeps;
  const orgs: string[] = [];
  const users: string[] = [];

  async function org() {
    const tag = Math.random().toString(36).slice(2, 8);
    const [{ id }] = await sql`insert into organizations (name, slug) values ('L', ${"lm-" + tag}) returning id`;
    const [{ id: userId }] = await sql`insert into users (name, email) values ('U', ${tag + "@lm.test"}) returning id`;
    users.push(userId);
    orgs.push(id);
    const actor: Actor = { userId, organizationId: id, role: "member" };
    return { id, actor };
  }

  const person = async (orgId: string, email: string | null, extra: { name?: string; slug?: string; custom?: object } = {}) => {
    const [{ id }] = await sql`
      insert into people (organization_id, email, linkedin_slug, first_name, full_name, custom)
      values (${orgId}, ${email}, ${extra.slug ?? null}, ${extra.name ?? "Pat"}, ${extra.name ?? "Pat Test"}, ${sql.json((extra.custom ?? {}) as never)})
      returning id`;
    return id as string;
  };

  /** Do not contact as the conversations context writes it (`setPersonDoNotContact`); its own tests cover that path. */
  const markDoNotContact = async (orgId: string, personId: string, reason: string) => {
    await sql`insert into contact_policies (person_id, organization_id, do_not_contact, reason, source, set_at) values (${personId}, ${orgId}, true, ${reason}, 'human', now())`;
  };

  const campaign = async (orgId: string, status: string) => {
    const [{ id }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${orgId}, 'email', ${"C " + status}, ${status}) returning id`;
    return id as string;
  };

  const enroll = async (orgId: string, campaignId: string, personId: string, status = "pending") => {
    const [{ id }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${orgId}, ${campaignId}, ${personId}, 'email', ${status}) returning id`;
    return id as string;
  };

  const csvOf = async (actor: Actor, filter: import("../../application/lead-ports").LeadFilter = {}) => {
    let text = "";
    for await (const chunk of uc.exportLeadsCsv(deps, actor, filter)) text += chunk;
    return text;
  };

  beforeAll(async () => {
    uc = await import("../../application/lead-management");
    deps = (await import("../composition")).leadDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  describe("edit", () => {
    it("normalizes like an import, attaches a company and keeps untouched fields", async () => {
      const { id: o, actor } = await org();
      const p = await person(o, "old@acme.com", { name: "Ada Kim" });
      await uc.updateLead(deps, actor, p, { email: " NEW@Acme.com ", linkedin: "https://www.linkedin.com/in/Ada-K/", phone: "010-1234-5678", defaultCountry: "KR", companyDomain: "https://www.acme.com/x", companyName: "Acme", title: "CTO" });
      const detail = await uc.getLead(deps, actor, p);
      expect(detail.person).toMatchObject({ email: "new@acme.com", linkedinSlug: "ada-k", phone: "+821012345678", companyDomain: "acme.com", companyName: "Acme", title: "CTO", fullName: "Ada Kim" });
    });

    it("sets, removes and adds custom fields and records the new column", async () => {
      const { id: o, actor } = await org();
      const p = await person(o, "c@acme.com", { custom: { x_size: "10", x_keep: "k" } });
      await uc.updateLead(deps, actor, p, { custom: { x_size: "", x_keep: "k2" }, newCustom: [{ label: "회사 규모", value: "큼" }] });
      const detail = await uc.getLead(deps, actor, p);
      expect(detail.person.custom).toMatchObject({ x_keep: "k2" });
      expect(detail.person.custom).not.toHaveProperty("x_size");
      expect(Object.values(detail.person.custom)).toContain("큼");
      expect(detail.customColumns.map((c) => c.name)).toContain("회사 규모");
    });

    it("answers 409 with the other lead's name when the email or LinkedIn profile is taken", async () => {
      const { id: o, actor } = await org();
      await person(o, "taken@acme.com", { name: "Taken Person", slug: "taken-slug" });
      const p = await person(o, "mine@acme.com", { name: "Mine" });
      const byEmail = uc.updateLead(deps, actor, p, { email: "TAKEN@acme.com" });
      await expect(byEmail).rejects.toBeInstanceOf(ConflictError);
      await expect(byEmail).rejects.toThrow(/Taken Person.*email/);
      await expect(uc.updateLead(deps, actor, p, { linkedin: "linkedin.com/in/taken-slug" })).rejects.toThrow(/LinkedIn profile/);
      // The failed edits changed nothing.
      expect((await uc.getLead(deps, actor, p)).person.email).toBe("mine@acme.com");
    });

    it("allows the same email in another organization", async () => {
      const a = await org();
      const b = await org();
      await person(a.id, "same@acme.com");
      const p = await person(b.id, "other@acme.com");
      await expect(uc.updateLead(deps, b.actor, p, { email: "same@acme.com" })).resolves.toBeUndefined();
    });

    it("rejects invalid values with a readable message and leaves the lead alone", async () => {
      const { id: o, actor } = await org();
      const p = await person(o, "v@acme.com");
      await expect(uc.updateLead(deps, actor, p, { email: "not-an-email" })).rejects.toBeInstanceOf(ValidationError);
      await expect(uc.updateLead(deps, actor, p, { email: "", linkedin: "" })).rejects.toThrow(/email or a LinkedIn/);
      expect((await uc.getLead(deps, actor, p)).person.email).toBe("v@acme.com");
    });

    it("answers NotFound for another organization's lead and for an unknown id", async () => {
      const a = await org();
      const b = await org();
      const p = await person(a.id, "x@acme.com");
      await expect(uc.updateLead(deps, b.actor, p, { title: "Hacked" })).rejects.toBeInstanceOf(NotFoundError);
      await expect(uc.getLead(deps, b.actor, p)).rejects.toBeInstanceOf(NotFoundError);
      await expect(uc.updateLead(deps, a.actor, "00000000-0000-4000-8000-000000000000", { title: "x" })).rejects.toBeInstanceOf(NotFoundError);
      expect((await uc.getLead(deps, a.actor, p)).person.title).toBeNull();
    });
  });

  describe("contacts", () => {
    const toContact = (personId: string) => sql`update people set lifecycle = 'contact', converted_at = '2026-10-01T10:00:00Z' where id = ${personId}`;

    it("lets an edit change fields of a contact and leaves lifecycle and converted_at alone", async () => {
      const { id: o, actor } = await org();
      const p = await person(o, "cy@acme.com", { name: "Cy Park" });
      await toContact(p);
      // The route validates the body first: a lifecycle or converted_at in a PATCH body is not a field of the edit.
      const { editSchema } = await import("@/app/api/leads/validation");
      const body = editSchema.parse({ title: "VP", phone: "+14155550123", companyDomain: "acme.com", companyName: "Acme", lifecycle: "lead", convertedAt: null });
      expect(body).not.toHaveProperty("lifecycle");
      expect(body).not.toHaveProperty("convertedAt");
      await uc.updateLead(deps, actor, p, body);
      const [row] = await sql`select title, lifecycle, converted_at from people where id = ${p}`;
      expect(row.title).toBe("VP");
      expect(row.lifecycle).toBe("contact");
      expect(new Date(row.converted_at).toISOString()).toBe("2026-10-01T10:00:00.000Z");
      expect((await uc.getLead(deps, actor, p)).person).toMatchObject({ title: "VP", lifecycle: "contact" });
    });

    it("answers blocked, never an error, when a contact is deleted by id, by filter or checked first", async () => {
      const { id: o, actor } = await org();
      const withEvent = await person(o, "has-event@acme.com", { name: "Event Contact" });
      const bare = await person(o, "bare@acme.com", { name: "Bare Contact" });
      const lead = await person(o, "lead@acme.com", { name: "Plain Lead" });
      await toContact(withEvent);
      await toContact(bare);
      await sql`insert into events (organization_id, person_id, event_type, actor_type) values (${o}, ${withEvent}, 'lifecycle.converted', 'system')`;

      const outcome = await uc.deleteLeads(deps, actor, { ids: [withEvent, bare, lead] });
      expect(outcome.deleted).toBe(1);
      expect(outcome.blocked.map((b) => `${b.id}:${b.reason}`).sort()).toEqual([`${withEvent}:linked_records`, `${bare}:linked_records`].sort());
      const [{ count }] = await sql`select count(*)::int as count from people where id in ${sql([withEvent, bare])}`;
      expect(count).toBe(2);

      const { checkLeadDelete } = await import("../../application/lead-delete-check");
      expect((await checkLeadDelete(deps, actor, bare)).canDelete).toBe(false);
      expect(await deps.leads.deleteBlock(o, bare)).toBe("linked_records");

      // The filter delete only sees leads: the contact is not in its count, and a contact filter reaches contacts but blocks them.
      const again = await person(o, "lead2@acme.com", { name: "Another Lead" });
      expect((await uc.deleteLeads(deps, actor, { filter: { query: "acme" }, confirmCount: 1 })).deleted).toBe(1);
      expect(await sql`select 1 from people where id = ${again}`).toHaveLength(0);
      const viaContactFilter = await uc.deleteLeads(deps, actor, { filter: { lifecycle: "contact" }, confirmCount: 2 });
      expect(viaContactFilter.deleted).toBe(0);
      expect(viaContactFilter.blocked).toHaveLength(2);
    });
  });

  describe("detail", () => {
    it("lists campaigns, sends and suppression", async () => {
      const { id: o, actor } = await org();
      const p = await person(o, "d@acme.com");
      const c = await campaign(o, "active");
      const e = await enroll(o, c, p, "active");
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, subject, sent_at) values (${o}, ${e}, 1, 'email', 'sent', 'Hello', now())`;
      await sql`insert into suppression_list (organization_id, email, reason) values (${o}, 'd@acme.com', 'unsubscribed')`;
      const detail = await uc.getLead(deps, actor, p);
      expect(detail.enrollments).toMatchObject([{ campaignName: "C active", status: "active", campaignStatus: "active" }]);
      expect(detail.sends).toMatchObject([{ stepNumber: 1, status: "sent", subject: "Hello", campaignName: "C active" }]);
      expect(detail.suppression?.reason).toBe("unsubscribed");
    });
  });

  describe("delete", () => {
    it("deletes plain leads and their unsent enrollments in a draft campaign", async () => {
      const { id: o, actor } = await org();
      const plain = await person(o, "p@acme.com");
      const drafted = await person(o, "dr@acme.com");
      await enroll(o, await campaign(o, "draft"), drafted);
      const result = await uc.deleteLeads(deps, actor, { ids: [plain, drafted] });
      expect(result).toEqual({ deleted: 2, blocked: [] });
      expect(await sql`select 1 from people where organization_id = ${o}`).toHaveLength(0);
    });

    it("refuses leads with sends history and leads in a running campaign", async () => {
      const { id: o, actor } = await org();
      const sent = await person(o, "sent@acme.com", { name: "Sent One" });
      const running = await person(o, "run@acme.com");
      const free = await person(o, "free@acme.com");
      const active = await campaign(o, "active");
      const e = await enroll(o, active, sent, "completed");
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status) values (${o}, ${e}, 1, 'email', 'sent')`;
      await enroll(o, active, running, "active");
      const result = await uc.deleteLeads(deps, actor, { ids: [sent, running, free] });
      expect(result.deleted).toBe(1);
      expect(result.blocked.map((b) => [b.id, b.reason]).sort()).toEqual([[sent, "has_sends"], [running, "in_active_campaign"]].sort());
      expect(await sql`select 1 from people where id in ${sql([sent, running])}`).toHaveLength(2);
    });

    it("lets a lead with only failed sends go", async () => {
      const { id: o, actor } = await org();
      const p = await person(o, "f@acme.com");
      const e = await enroll(o, await campaign(o, "paused"), p, "failed");
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status) values (${o}, ${e}, 1, 'email', 'failed')`;
      expect((await uc.deleteLeads(deps, actor, { ids: [p] })).deleted).toBe(1);
    });

    it("refuses a lead with a CRM record", async () => {
      const { id: o, actor } = await org();
      const p = await person(o, "crm@acme.com");
      const [{ id: pipeline }] = await sql`insert into pipelines (organization_id, name) values (${o}, 'P') returning id`;
      await sql`insert into records (organization_id, person_id, pipeline_id) values (${o}, ${p}, ${pipeline})`;
      const result = await uc.deleteLeads(deps, actor, { ids: [p] });
      expect(result.deleted).toBe(0);
      expect(result.blocked).toMatchObject([{ id: p, reason: "linked_records" }]);
    });

    it("keeps a do-not-contact address on the suppression list after deleting the lead", async () => {
      const { id: o, actor } = await org();
      const p = await person(o, "Stop@Acme.com");
      await markDoNotContact(o, p, "Asked");
      expect((await uc.deleteLeads(deps, actor, { ids: [p] })).deleted).toBe(1);
      const rows = await sql`select email, reason from suppression_list where organization_id = ${o}`;
      expect(rows).toMatchObject([{ email: "stop@acme.com", reason: "manual" }]);
    });

    it("ignores ids from another organization", async () => {
      const a = await org();
      const b = await org();
      const p = await person(a.id, "mine@acme.com");
      expect(await uc.deleteLeads(deps, b.actor, { ids: [p] })).toEqual({ deleted: 0, blocked: [] });
      expect(await sql`select 1 from people where id = ${p}`).toHaveLength(1);
    });

    it("deletes by filter only with the confirmed count", async () => {
      const { id: o, actor } = await org();
      await person(o, "a1@keep.com");
      for (let i = 0; i < 3; i += 1) await person(o, `x${i}@gone.com`);
      await expect(uc.deleteLeads(deps, actor, { filter: { query: "gone.com" }, confirmCount: 2 })).rejects.toBeInstanceOf(ConflictError);
      expect(await uc.countLeads(deps, actor, { query: "gone.com" })).toBe(3);
      expect(await uc.deleteLeads(deps, actor, { filter: { query: "gone.com" }, confirmCount: 3 })).toEqual({ deleted: 3, blocked: [] });
      expect(await uc.countLeads(deps, actor, {})).toBe(1);
    });

    it("rejects an empty selection and an oversized one", async () => {
      const { actor } = await org();
      await expect(uc.deleteLeads(deps, actor, { ids: [] })).rejects.toBeInstanceOf(ValidationError);
      const many = Array.from({ length: uc.MAX_DELETE_IDS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
      await expect(uc.deleteLeads(deps, actor, { ids: many })).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("export", () => {
    it("writes BOM, header, custom columns, escaped formulas, and only this organization", async () => {
      const a = await org();
      const b = await org();
      await sql`insert into entity_columns (organization_id, entity, key, name, type, position) values (${a.id}, 'people', 'x_size', '회사 규모', 'text', 1)`;
      const p = await person(a.id, "e@acme.com", { name: "=HYPERLINK(\"http://evil\")", custom: { x_size: "큼, 아주" } });
      await sql`update people set title = '@SUM(1)', phone = '+821012345678' where id = ${p}`;
      await person(b.id, "other@else.com");
      const text = await csvOf(a.actor);
      expect(text.startsWith("﻿")).toBe(true);
      const lines = text.slice(1).trimEnd().split("\r\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("회사 규모");
      expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
      expect(lines[1]).toContain("'@SUM(1)");
      expect(lines[1]).toContain('"큼, 아주"');
      expect(text).not.toContain("other@else.com");
    });

    it("exports only the current filter", async () => {
      const { id: o, actor } = await org();
      await person(o, "one@alpha.com");
      await person(o, "two@beta.com");
      const text = await csvOf(actor, { query: "alpha" });
      expect(text).toContain("one@alpha.com");
      expect(text).not.toContain("two@beta.com");
    });

    it("streams more than one batch without losing or repeating rows", async () => {
      const { id: o, actor } = await org();
      await sql`insert into people (organization_id, email, full_name) select ${o}, 'bulk' || g || '@many.com', 'Bulk ' || g from generate_series(1, 2150) g`;
      const text = await csvOf(actor);
      const emails = text.match(/bulk\d+@many\.com/g) ?? [];
      expect(emails).toHaveLength(2150);
      expect(new Set(emails).size).toBe(2150);
    });

    it("exports ticked ids exactly, contacts included, and only this organization's", async () => {
      const a = await org();
      const b = await org();
      const lead = await person(a.id, "lead@ticked.com");
      const contact = await person(a.id, "contact@ticked.com");
      await person(a.id, "unticked@ticked.com");
      const foreign = await person(b.id, "foreign@ticked.com");
      await sql`update people set lifecycle = 'contact', converted_at = now() where id in ${sql([contact, foreign])}`;
      // The list under lifecycle=all sends only the ids; the default lifecycle (lead) must not drop the contact.
      for (const filter of [{ ids: [lead, contact, foreign] }, { ids: [lead, contact, foreign], lifecycle: "contact" as const, query: "nomatch" }]) {
        const emails = ((await csvOf(a.actor, filter)).match(/[a-z]+@ticked\.com/g) ?? []).sort();
        expect(emails).toEqual(["contact@ticked.com", "lead@ticked.com"]);
      }
    });

    it("marks do-not-contact leads", async () => {
      const { id: o, actor } = await org();
      const p = await person(o, "dnc@acme.com");
      await markDoNotContact(o, p, "x");
      expect(await csvOf(actor)).toMatch(/dnc@acme\.com.*,yes,/);
    });
  });

  describe("list", () => {
    it("honours the page size and flags do-not-contact", async () => {
      const { id: o } = await org();
      const { listLeads } = await import("../queries");
      await sql`insert into people (organization_id, email, full_name) select ${o}, 'p' || g || '@list.com', 'P ' || g from generate_series(1, 60) g`;
      const first = await listLeads(o, { pageSize: 25 });
      expect(first.rows).toHaveLength(25);
      expect(first.pageCount).toBe(3);
      expect((await listLeads(o, { pageSize: 7 })).pageSize).toBe(50);
      const p = first.rows[0].id;
      await markDoNotContact(o, p, "x");
      expect((await listLeads(o, { pageSize: 25 })).rows.find((r) => r.id === p)?.doNotContact).toBe(true);
    });
  });
});
