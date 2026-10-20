import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestOrg, describeDb, dropOrgs, TEST_DATABASE_URL, testSql, uniqueKey, waitForLockWaiters, type TestOrg } from "../../../test-support/db";
import { uid } from "../../../test-support/full-world";

/**
 * The schema rules of leads, contacts, deals, companies and record assignees on the migrated database: each CHECK, key and
 * guard trigger gets a failing case and a passing one, and the two-connection races between a send and a conversion end
 * without a deadlock. Needs TEST_DATABASE_URL.
 */
const STAGES: Array<[string, string, number]> = [["New", "open", 1], ["Meeting", "open", 2], ["Proposal", "open", 3], ["Won", "won", 4], ["Lost", "lost", 5]];

type Failure = { code?: string; message: string; constraint_name?: string };

async function rejection(run: PromiseLike<unknown>): Promise<Failure> {
  try {
    await run;
  } catch (error) {
    return error as Failure;
  }
  throw new Error("expected the statement to fail");
}

describeDb("contacts, deals, companies and assignees schema", () => {
  const sql = testSql({ max: 4 });
  let a: TestOrg;
  let b: TestOrg;
  let orgA: string;
  let orgB: string;
  let campaign: string;
  let campaignB: string;
  let pipeline: string;
  // Ann and Bob are members of A, Carl of B only, Dana of no organization.
  let ann: string;
  let bob: string;
  let carl: string;
  let dana: string;
  const users: string[] = [];

  async function user(label: string): Promise<string> {
    const [row] = await sql<{ id: string }[]>`insert into users (name, email) values (${label}, ${`${label}-${uniqueKey()}@schema.test`}) returning id`;
    users.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    a = await createTestOrg(sql, "A");
    b = await createTestOrg(sql, "B");
    orgA = a.organizationId;
    orgB = b.organizationId;
    ann = a.userId;
    carl = b.userId;
    bob = await user("Bob");
    dana = await user("Dana");
    await sql`insert into members (organization_id, user_id, role) values (${orgA}, ${bob}, 'member')`;
    for (const org of [orgA, orgB]) {
      for (const [name, kind, position] of STAGES) await sql`insert into deal_stages (organization_id, name, kind, position) values (${org}, ${name}, ${kind}, ${position})`;
    }
    [{ id: campaign }] = await sql<{ id: string }[]>`insert into campaigns (organization_id, channel, name) values (${orgA}, 'email', 'c') returning id`;
    [{ id: campaignB }] = await sql<{ id: string }[]>`insert into campaigns (organization_id, channel, name) values (${orgB}, 'email', 'cb') returning id`;
    [{ id: pipeline }] = await sql<{ id: string }[]>`insert into pipelines (organization_id, name, is_default) values (${orgA}, 'Default', true) returning id`;
  });

  afterAll(async () => {
    await dropOrgs(sql, [a, b], users);
    await sql.end();
  });

  const email = () => `${uniqueKey()}@schema.test`;
  async function lead(org = orgA, companyId: string | null = null): Promise<string> {
    const [row] = await sql<{ id: string }[]>`insert into people (organization_id, email, full_name, company_id) values (${org}, ${email()}, 'L', ${companyId}) returning id`;
    return row.id;
  }
  async function contact(org = orgA): Promise<string> {
    const [row] = await sql<{ id: string }[]>`insert into people (organization_id, email, full_name, lifecycle, converted_at) values (${org}, ${email()}, 'C', 'contact', now()) returning id`;
    return row.id;
  }
  const convert = (person: string) => sql`update people set lifecycle = 'contact', converted_at = now() where id = ${person}`;
  async function stage(org: string, stageName: string): Promise<{ id: string; kind: string }> {
    const [row] = await sql<{ id: string; kind: string }[]>`select id, kind from deal_stages where organization_id = ${org} and name = ${stageName}`;
    return row;
  }
  async function insertDeal(person: string, stageName = "New", extra: Record<string, unknown> = {}, org = orgA): Promise<string> {
    const s = await stage(org, stageName);
    const row = { organization_id: org, person_id: person, stage_id: s.id, stage_kind: s.kind, title: "Deal", ...(s.kind === "open" ? {} : { closed_at: new Date().toISOString() }), ...(s.kind === "lost" ? { lost_reason: "No budget" } : {}), ...extra };
    const [created] = await sql<{ id: string }[]>`insert into deals ${sql(row as never)} returning id`;
    return created.id;
  }
  async function enrollment(person: string, status: string, org = orgA, camp = campaign): Promise<string> {
    const [row] = await sql<{ id: string }[]>`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${org}, ${camp}, ${person}, 'email', ${status}) returning id`;
    return row.id;
  }
  async function company(org = orgA, domain = `${uniqueKey()}.test`): Promise<{ id: string; domain: string }> {
    const [row] = await sql<{ id: string }[]>`insert into companies (organization_id, domain) values (${org}, ${domain}) returning id`;
    return { id: row.id, domain };
  }
  async function alias(companyId: string, domain = `${uniqueKey()}.test`, org = orgA): Promise<string> {
    const [row] = await sql<{ id: string }[]>`insert into company_domain_aliases (organization_id, company_id, domain) values (${org}, ${companyId}, ${domain}) returning id`;
    return row.id;
  }
  async function record(): Promise<string> {
    const [row] = await sql<{ id: string }[]>`insert into records (organization_id, person_id, pipeline_id) values (${orgA}, ${await lead()}, ${pipeline}) returning id`;
    return row.id;
  }

  describe("people lifecycle", () => {
    it("rejects a lifecycle outside lead and contact", async () => {
      const person = await lead();
      expect(await rejection(sql`update people set lifecycle = 'customer' where id = ${person}`)).toMatchObject({ constraint_name: "people_lifecycle_ck" });
      expect(await rejection(sql`insert into people (organization_id, email, lifecycle) values (${orgA}, ${email()}, 'customer')`)).toMatchObject({ constraint_name: "people_lifecycle_ck" });
    });

    it("rejects a contact without converted_at and a lead with it", async () => {
      expect(await rejection(sql`insert into people (organization_id, email, lifecycle) values (${orgA}, ${email()}, 'contact')`)).toMatchObject({ constraint_name: "people_converted_at_ck" });
      expect(await rejection(sql`insert into people (organization_id, email, converted_at) values (${orgA}, ${email()}, now())`)).toMatchObject({ constraint_name: "people_converted_at_ck" });
      const person = await lead();
      expect(await rejection(sql`update people set converted_at = now() where id = ${person}`)).toMatchObject({ constraint_name: "people_converted_at_ck" });
      expect(await rejection(sql`update people set lifecycle = 'contact' where id = ${person}`)).toMatchObject({ constraint_name: "people_converted_at_ck" });
    });

    it("lets a lead become a contact once, and lets other columns of a contact change", async () => {
      const person = await lead();
      await convert(person);
      await sql`update people set full_name = 'Renamed', lifecycle = 'contact' where id = ${person}`;
      const [row] = await sql`select lifecycle, converted_at, full_name from people where id = ${person}`;
      expect(row).toMatchObject({ lifecycle: "contact", full_name: "Renamed" });
      expect(row.converted_at).not.toBeNull();
    });

    it("rejects a contact that goes back to lead", async () => {
      const person = await contact();
      expect((await rejection(sql`update people set lifecycle = 'lead', converted_at = null where id = ${person}`)).message).toMatch(/never becomes a lead again/);
      expect((await rejection(sql`update people set lifecycle = 'lead' where id = ${person}`)).message).toMatch(/never becomes a lead again/);
    });

    it("rejects a change of converted_at once set", async () => {
      const person = await contact();
      expect((await rejection(sql`update people set converted_at = now() + interval '1 day' where id = ${person}`)).message).toMatch(/converted_at cannot change once set/);
      expect((await rejection(sql`update people set converted_at = null where id = ${person}`)).message).toMatch(/converted_at cannot change once set/);
      await sql`update people set converted_at = converted_at where id = ${person}`;
    });

    it("refuses a creation_key of 7 or 201 characters and takes 8 and 200", async () => {
      const person = (key: string) => sql`insert into people (organization_id, email, creation_key) values (${orgA}, ${email()}, ${key})`;
      expect(await rejection(person("k".repeat(7)))).toMatchObject({ constraint_name: "people_creation_key_ck" });
      expect(await rejection(person("k".repeat(201)))).toMatchObject({ constraint_name: "people_creation_key_ck" });
      await person(uniqueKey().padEnd(8, "k").slice(0, 8));
      await person(uniqueKey().padEnd(200, "k"));
    });

    it("keeps one creation_key per organization", async () => {
      const key = `key-${uniqueKey()}`;
      await sql`insert into people (organization_id, email, creation_key) values (${orgA}, ${email()}, ${key})`;
      expect(await rejection(sql`insert into people (organization_id, email, creation_key) values (${orgA}, ${email()}, ${key})`)).toMatchObject({ code: "23505", constraint_name: "people_creation_key_uq" });
      await sql`insert into people (organization_id, email, creation_key) values (${orgB}, ${email()}, ${key})`;
      await sql`insert into people (organization_id, email) values (${orgA}, ${email()}), (${orgA}, ${email()})`;
    });

    it("refuses a person that points at a company of another organization", async () => {
      const foreign = await company(orgB);
      const person = await lead();
      expect(await rejection(sql`update people set company_id = ${foreign.id} where id = ${person}`)).toMatchObject({ constraint_name: "people_company_fk" });
      expect(await rejection(sql`insert into people (organization_id, email, company_id) values (${orgA}, ${email()}, ${foreign.id})`)).toMatchObject({ constraint_name: "people_company_fk" });
    });

    it("sets only company_id to null when the company is deleted", async () => {
      const own = await company();
      const person = await lead(orgA, own.id);
      await sql`delete from companies where id = ${own.id}`;
      const [row] = await sql`select organization_id, company_id from people where id = ${person}`;
      expect(row).toEqual({ organization_id: orgA, company_id: null });
    });
  });

  describe("deal stages", () => {
    it("rejects a change of a stage kind and lets a stage be renamed and moved", async () => {
      const s = await stage(orgA, "Meeting");
      expect((await rejection(sql`update deal_stages set kind = 'won' where id = ${s.id}`)).message).toMatch(/deal_stages\.kind is immutable/);
      await sql`update deal_stages set kind = 'open', name = 'Meeting' where id = ${s.id}`;
      await sql`update deal_stages set name = 'Meeting 2' where id = ${s.id}`;
      await sql`update deal_stages set name = 'Meeting' where id = ${s.id}`;
    });

    it("rejects a stage name that repeats in other case, a blank or long name and an unknown kind", async () => {
      expect(await rejection(sql`insert into deal_stages (organization_id, name, kind, position) values (${orgA}, 'new', 'open', 9)`)).toMatchObject({ constraint_name: "deal_stages_org_name_uq" });
      expect(await rejection(sql`insert into deal_stages (organization_id, name, kind, position) values (${orgA}, ' ', 'open', 9)`)).toMatchObject({ constraint_name: "deal_stages_name_ck" });
      expect(await rejection(sql`insert into deal_stages (organization_id, name, kind, position) values (${orgA}, ${"x".repeat(61)}, 'open', 9)`)).toMatchObject({ constraint_name: "deal_stages_name_ck" });
      expect(await rejection(sql`insert into deal_stages (organization_id, name, kind, position) values (${orgA}, 'Odd', 'paused', 9)`)).toMatchObject({ constraint_name: "deal_stages_kind_ck" });
    });

    it("declares the position key DEFERRABLE INITIALLY DEFERRED", async () => {
      const [row] = await sql`select condeferrable, condeferred from pg_constraint where conname = 'deal_stages_org_position_uq'`;
      expect(row).toMatchObject({ condeferrable: true, condeferred: true });
    });

    it("swaps two positions in one transaction, and fails a duplicate position at commit", async () => {
      const positions = async () => (await sql`select name, position from deal_stages where organization_id = ${orgB} order by position`).map((r) => `${r.name}:${r.position}`);
      expect(await positions()).toEqual(["New:1", "Meeting:2", "Proposal:3", "Won:4", "Lost:5"]);
      await sql.begin(async (tx) => {
        await tx`update deal_stages set position = 3 - position where organization_id = ${orgB} and name in ('New', 'Meeting')`;
      });
      expect(await positions()).toEqual(["Meeting:1", "New:2", "Proposal:3", "Won:4", "Lost:5"]);
      await sql.begin(async (tx) => {
        await tx`update deal_stages set position = 1 where organization_id = ${orgB} and name = 'New'`;
        await tx`update deal_stages set position = 2 where organization_id = ${orgB} and name = 'Meeting'`;
      });
      expect(await positions()).toEqual(["New:1", "Meeting:2", "Proposal:3", "Won:4", "Lost:5"]);
      const error = await rejection(
        sql.begin(async (tx) => {
          await tx`update deal_stages set position = 2 where organization_id = ${orgB} and name = 'New'`;
        }),
      );
      expect(error).toMatchObject({ code: "23505", constraint_name: "deal_stages_org_position_uq" });
      expect(await positions()).toEqual(["New:1", "Meeting:2", "Proposal:3", "Won:4", "Lost:5"]);
    });

    it("deletes a stage with no deals", async () => {
      const [created] = await sql`insert into deal_stages (organization_id, name, kind, position) values (${orgA}, 'Scratch', 'open', 99) returning id`;
      await sql`delete from deal_stages where id = ${created.id}`;
      expect(await sql`select id from deal_stages where id = ${created.id}`).toEqual([]);
    });
  });

  describe("deals", () => {
    it("rejects an amount without a currency, a currency without an amount, a negative amount and one above 2^53 - 1", async () => {
      const person = await contact();
      expect(await rejection(insertDeal(person, "New", { amount_minor: 100 }))).toMatchObject({ constraint_name: "deals_currency_pair_ck" });
      expect(await rejection(insertDeal(person, "New", { currency: "USD" }))).toMatchObject({ constraint_name: "deals_currency_pair_ck" });
      expect(await rejection(insertDeal(person, "New", { amount_minor: -1, currency: "USD" }))).toMatchObject({ constraint_name: "deals_amount_ck" });
      expect(await rejection(insertDeal(person, "New", { amount_minor: "9007199254740992", currency: "USD" }))).toMatchObject({ constraint_name: "deals_amount_ck" });
      await insertDeal(person, "New", { amount_minor: "9007199254740991", currency: "KRW" });
      await insertDeal(person, "New", { amount_minor: 0, currency: "USD" });
    });

    it("rejects closed_at on an open stage and a missing closed_at on a closed one", async () => {
      const person = await contact();
      expect(await rejection(insertDeal(person, "New", { closed_at: new Date().toISOString() }))).toMatchObject({ constraint_name: "deals_closed_at_ck" });
      expect(await rejection(insertDeal(person, "Won", { closed_at: null }))).toMatchObject({ constraint_name: "deals_closed_at_ck" });
      expect(await rejection(insertDeal(person, "Lost", { closed_at: null }))).toMatchObject({ constraint_name: "deals_closed_at_ck" });
      await insertDeal(person, "Won");
    });

    it("rejects lost_reason on a stage that is not lost and a lost deal without one", async () => {
      const person = await contact();
      expect(await rejection(insertDeal(person, "New", { lost_reason: "No budget" }))).toMatchObject({ constraint_name: "deals_lost_reason_ck" });
      expect(await rejection(insertDeal(person, "Won", { lost_reason: "No budget" }))).toMatchObject({ constraint_name: "deals_lost_reason_ck" });
      expect(await rejection(insertDeal(person, "Lost", { lost_reason: null }))).toMatchObject({ constraint_name: "deals_lost_reason_ck" });
      expect(await rejection(insertDeal(person, "Lost", { lost_reason: "x".repeat(501) }))).toMatchObject({ constraint_name: "deals_lost_reason_len_ck" });
      await insertDeal(person, "Lost");
    });

    it("rejects a blank or long title and a negative version", async () => {
      const person = await contact();
      expect(await rejection(insertDeal(person, "New", { title: " " }))).toMatchObject({ constraint_name: "deals_title_ck" });
      expect(await rejection(insertDeal(person, "New", { title: "x".repeat(201) }))).toMatchObject({ constraint_name: "deals_title_ck" });
      expect(await rejection(insertDeal(person, "New", { version: -1 }))).toMatchObject({ constraint_name: "deals_version_ck" });
    });

    it("rejects a deal for a lead", async () => {
      const person = await lead();
      expect((await rejection(insertDeal(person))).message).toMatch(/deals\.person_id must be a contact/);
      await convert(person);
      await insertDeal(person);
    });

    it("rejects a change of a deal's person or organization", async () => {
      const first = await contact();
      const second = await contact();
      const deal = await insertDeal(first);
      expect((await rejection(sql`update deals set person_id = ${second} where id = ${deal}`)).message).toMatch(/person_id and deals\.organization_id are immutable/);
      expect((await rejection(sql`update deals set organization_id = ${orgB} where id = ${deal}`)).message).toMatch(/immutable/);
      await sql`update deals set person_id = person_id, title = 'Renamed', version = version + 1 where id = ${deal}`;
    });

    it("rejects a deal for another organization's person", async () => {
      const foreign = await contact(orgB);
      expect(await rejection(insertDeal(foreign, "New", {}, orgA))).toMatchObject({ constraint_name: "deals_person_fk" });
    });

    it("rejects a stage of another organization and a stage_kind that is not the stage's kind", async () => {
      const person = await contact();
      const other = await stage(orgB, "New");
      expect(await rejection(insertDeal(person, "New", { stage_id: other.id }))).toMatchObject({ constraint_name: "deals_stage_fk" });
      expect(await rejection(insertDeal(person, "New", { stage_kind: "won", closed_at: new Date().toISOString() }))).toMatchObject({ constraint_name: "deals_stage_fk" });
    });

    it("moves a deal when stage_id and stage_kind change in one statement, and not when only one does", async () => {
      const person = await contact();
      const deal = await insertDeal(person, "New");
      const won = await stage(orgA, "Won");
      expect(await rejection(sql`update deals set stage_id = ${won.id}, version = version + 1 where id = ${deal}`)).toMatchObject({ constraint_name: "deals_stage_fk" });
      await sql`update deals set stage_id = ${won.id}, stage_kind = ${won.kind}, closed_at = now() where id = ${deal}`;
    });

    it("refuses to delete a stage that has deals, and a person that has a deal", async () => {
      const person = await contact();
      const s = await stage(orgA, "Proposal");
      await insertDeal(person, "Proposal");
      expect(await rejection(sql`delete from deal_stages where id = ${s.id}`)).toMatchObject({ constraint_name: "deals_stage_fk" });
      expect(await rejection(sql`delete from people where id = ${person}`)).toMatchObject({ constraint_name: "deals_person_fk" });
    });

    it("keeps one idempotency key per person and organization", async () => {
      const person = await contact();
      const other = await contact();
      const key = uniqueKey();
      await insertDeal(person, "New", { idempotency_key: key });
      expect(await rejection(insertDeal(person, "New", { idempotency_key: key }))).toMatchObject({ constraint_name: "deals_idempotency_uq" });
      await insertDeal(other, "New", { idempotency_key: key });
      await insertDeal(person, "New");
      await insertDeal(person, "New");
    });

    it("refuses a source enrollment of another organization", async () => {
      const person = await contact();
      const foreign = await enrollment(await lead(orgB), "completed", orgB, campaignB);
      expect(await rejection(insertDeal(person, "New", { source_enrollment_id: foreign }))).toMatchObject({ constraint_name: "deals_source_enrollment_fk" });
    });

    it("sets owner_user_id and created_by to null when the user is deleted", async () => {
      const person = await contact();
      const [created] = await sql<{ id: string }[]>`insert into users (name, email) values ('O', ${email()}) returning id`;
      const deal = await insertDeal(person, "New", { owner_user_id: created.id, created_by: created.id });
      await sql`delete from users where id = ${created.id}`;
      const [row] = await sql`select owner_user_id, created_by from deals where id = ${deal}`;
      expect(row).toEqual({ owner_user_id: null, created_by: null });
    });
  });

  describe("campaign_enrollments for contacts", () => {
    it("refuses a pending or active enrollment for a contact, with the named message", async () => {
      const person = await contact();
      for (const status of ["pending", "active"]) {
        expect(await rejection(enrollment(person, status))).toMatchObject({ code: "23514", message: "contact_cannot_be_enrolled" });
      }
      expect(await rejection(sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${orgA}, ${campaign}, ${person}, 'email')`)).toMatchObject({ message: "contact_cannot_be_enrolled" });
    });

    it("lets a lead be enrolled, and lets an enrollment that is already over be inserted for a contact", async () => {
      await enrollment(await lead(), "pending");
      await enrollment(await lead(), "active");
      for (const status of ["replied", "completed", "suppressed", "cancelled", "removed"]) await enrollment(await contact(), status);
    });

    it("refuses to restore a removed enrollment of a contact, to pending or to active", async () => {
      for (const target of ["pending", "active"]) {
        const person = await lead();
        const id = await enrollment(person, "removed");
        await convert(person);
        expect(await rejection(sql`update campaign_enrollments set status = ${target} where id = ${id}`)).toMatchObject({ code: "23514", message: "contact_cannot_be_enrolled" });
      }
    });

    it("restores a removed enrollment of a lead", async () => {
      const id = await enrollment(await lead(), "removed");
      await sql`update campaign_enrollments set status = 'pending' where id = ${id}`;
      expect((await sql`select status from campaign_enrollments where id = ${id}`)[0].status).toBe("pending");
    });

    it.each(["replied", "suppressed", "cancelled", "removed", "completed", "bounced", "failed"])("lets a pending and an active enrollment of a contact move to %s", async (target) => {
      for (const from of ["pending", "active"]) {
        const person = await lead();
        const id = await enrollment(person, from);
        await convert(person);
        await sql`update campaign_enrollments set status = ${target}, stop_reason = 'converted' where id = ${id}`;
      }
    });

    it("lets the send engine write a contact's enrollment: pending to active, and active to active", async () => {
      const person = await lead();
      const id = await enrollment(person, "pending");
      await convert(person);
      await sql`update campaign_enrollments set status = 'active', current_step = 1, last_sent_at = now() where id = ${id}`;
      await sql`update campaign_enrollments set status = 'active', current_step = 2, next_send_at = now() where id = ${id}`;
      await sql`update campaign_enrollments set merge_fields = '{}'::jsonb where id = ${id}`;
    });

    it("makes an enrollment insert wait for a conversion in flight, then refuse it", async () => {
      const person = await lead();
      const writer = postgres(TEST_DATABASE_URL ?? "", { max: 1, onnotice: () => undefined });
      const inserter = postgres(TEST_DATABASE_URL ?? "", { max: 1, onnotice: () => undefined });
      try {
        await writer`begin`;
        await writer`update people set lifecycle = 'contact', converted_at = now() where id = ${person}`;
        const pending = inserter`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${orgA}, ${campaign}, ${person}, 'email')`.then(
          () => ({ ok: true as const }),
          (error: { message: string }) => ({ ok: false as const, message: error.message }),
        );
        await waitForLockWaiters(sql, 1);
        await writer`commit`;
        expect(await pending).toEqual({ ok: false, message: "contact_cannot_be_enrolled" });
      } finally {
        await writer.end();
        await inserter.end();
      }
    });

    it("ends a markSent that races a conversion without a deadlock", async () => {
      // A is the send engine: pending to active, then a second write to the same row. B is the conversion: the people row,
      // then the person's enrollments. The first write of A holds the enrollment row, the first write of B holds the person,
      // and the second write of A would need the person if the UPDATE trigger read it for active to active. It must not.
      // A lock_timeout turns a wait that should not happen into an error instead of a hang.
      const person = await lead();
      const id = await enrollment(person, "pending");
      const sendEngine = postgres(TEST_DATABASE_URL ?? "", { max: 1, onnotice: () => undefined });
      const conversion = postgres(TEST_DATABASE_URL ?? "", { max: 1, onnotice: () => undefined });
      const settle = <T>(run: PromiseLike<T>) => Promise.resolve(run).then(() => null, (error: Failure) => error);
      try {
        await sendEngine`begin`;
        await sendEngine`set local lock_timeout = '5s'`;
        await sendEngine`update campaign_enrollments set status = 'active', current_step = 1 where id = ${id}`;
        await conversion`begin`;
        await conversion`set local lock_timeout = '5s'`;
        expect(await settle(conversion`update people set lifecycle = 'contact', converted_at = now() where id = ${person}`), "the send engine's first write must not lock the person").toBeNull();
        await conversion`set local lock_timeout = 0`;
        const stop = settle(conversion`update campaign_enrollments set status = 'cancelled', stop_reason = 'converted' where id = ${id}`);
        await waitForLockWaiters(sql, 1);
        expect(await settle(sendEngine`update campaign_enrollments set status = 'active', current_step = 2, last_sent_at = now() where id = ${id}`), "the send engine's second write must not wait for the person").toBeNull();
        expect(await settle(sendEngine`commit`)).toBeNull();
        expect(await stop).toBeNull();
        expect(await settle(conversion`commit`)).toBeNull();
      } finally {
        await sendEngine`rollback`.catch(() => undefined);
        await conversion`rollback`.catch(() => undefined);
        await sendEngine.end();
        await conversion.end();
      }
      const [row] = await sql`select status, stop_reason from campaign_enrollments where id = ${id}`;
      expect(row).toEqual({ status: "cancelled", stop_reason: "converted" });
      const [p] = await sql`select lifecycle from people where id = ${person}`;
      expect(p.lifecycle).toBe("contact");
    }, 20_000);
  });

  describe("companies and their other domains", () => {
    it("refuses a negative company version", async () => {
      const { id } = await company();
      expect(await rejection(sql`update companies set version = -1 where id = ${id}`)).toMatchObject({ constraint_name: "companies_version_ck" });
      await sql`update companies set version = version + 1 where id = ${id}`;
      expect((await sql`select version from companies where id = ${id}`)[0].version).toBe(1);
    });

    it("refuses an alias domain that is not lowercased and trimmed, or shorter than 3 or longer than 253 characters", async () => {
      const { id } = await company();
      for (const domain of ["Upper.test", " pad.test", "pad.test ", "ab", `${"a".repeat(250)}.test`]) {
        expect(await rejection(alias(id, domain)), domain).toMatchObject({ constraint_name: "company_domain_aliases_domain_ck" });
      }
      await alias(id, "a.b");
      await alias(id, `${"a".repeat(248)}.test`);
    });

    it("keeps one alias per domain and organization", async () => {
      const first = await company();
      const second = await company();
      const domain = `${uniqueKey()}.test`;
      await alias(first.id, domain);
      expect(await rejection(alias(second.id, domain))).toMatchObject({ code: "23505", constraint_name: "company_domain_aliases_org_domain_uq" });
      const other = await company(orgB);
      await alias(other.id, domain, orgB);
    });

    it("refuses another organization's company and a company that does not exist", async () => {
      const foreign = await company(orgB);
      expect(await rejection(alias(foreign.id, `${uniqueKey()}.test`, orgA))).toMatchObject({ code: "23503", constraint_name: "company_domain_aliases_company_fk" });
      expect(await rejection(alias(uid()))).toMatchObject({ code: "23503", constraint_name: "company_domain_aliases_company_fk" });
    });

    it("moves an alias to another company of the organization", async () => {
      const from = await company();
      const to = await company();
      const id = await alias(from.id);
      await sql`update company_domain_aliases set company_id = ${to.id} where id = ${id}`;
      expect((await sql`select company_id from company_domain_aliases where id = ${id}`)[0].company_id).toBe(to.id);
    });

    it("sets created_by to null when the user is deleted", async () => {
      const [{ id: creator }] = await sql<{ id: string }[]>`insert into users (name, email) values ('U', ${email()}) returning id`;
      const { id: companyId } = await company();
      const [{ id }] = await sql`insert into company_domain_aliases (organization_id, company_id, domain, created_by) values (${orgA}, ${companyId}, ${uniqueKey() + ".test"}, ${creator}) returning id`;
      await sql`delete from users where id = ${creator}`;
      expect((await sql`select created_by from company_domain_aliases where id = ${id}`)[0].created_by).toBeNull();
    });

    it("refuses a company whose domain is an alias in the organization, on insert and on a domain change", async () => {
      const owner = await company();
      const domain = `${uniqueKey()}.test`;
      await alias(owner.id, domain);
      expect(await rejection(company(orgA, domain))).toMatchObject({ code: "23505", constraint_name: "company_domain_is_alias" });
      const other = await company();
      expect(await rejection(sql`update companies set domain = ${domain} where id = ${other.id}`)).toMatchObject({ code: "23505", constraint_name: "company_domain_is_alias" });
      expect(
        await rejection(sql`insert into companies (organization_id, domain) values (${orgA}, ${domain}) on conflict (organization_id, domain) do update set name = excluded.name`),
      ).toMatchObject({ code: "23505", constraint_name: "company_domain_is_alias" });
    });

    it("lets another organization use the alias as its company domain, and lets an upsert of a company domain through", async () => {
      const owner = await company();
      const domain = `${uniqueKey()}.test`;
      await alias(owner.id, domain);
      await company(orgB, domain);
      const same = await company();
      await sql`insert into companies (organization_id, domain, name) values (${orgA}, ${same.domain}, 'Renamed') on conflict (organization_id, domain) do update set name = excluded.name, version = companies.version + 1`;
      expect((await sql`select name, version from companies where id = ${same.id}`)[0]).toEqual({ name: "Renamed", version: 1 });
      await sql`update companies set name = 'Again' where id = ${same.id}`;
    });

    it("refuses an alias that is a company domain in the organization, on insert and on a domain change", async () => {
      const target = await company();
      const owner = await company();
      expect(await rejection(alias(owner.id, target.domain))).toMatchObject({ code: "23505", constraint_name: "alias_is_company_domain" });
      const id = await alias(owner.id);
      expect(await rejection(sql`update company_domain_aliases set domain = ${target.domain} where id = ${id}`)).toMatchObject({ code: "23505", constraint_name: "alias_is_company_domain" });
    });

    it("lets an alias take the domain of another organization's company, and of a company deleted first", async () => {
      const elsewhere = await company(orgB);
      const owner = await company();
      await alias(owner.id, elsewhere.domain);
      const merged = await company();
      await sql.begin(async (tx) => {
        await tx`delete from companies where id = ${merged.id}`;
        await tx`insert into company_domain_aliases (organization_id, company_id, domain, merged_company_id, merged_name) values (${orgA}, ${owner.id}, ${merged.domain}, ${merged.id}, 'Merged')`;
      });
      expect((await sql`select company_id, merged_company_id from company_domain_aliases where domain = ${merged.domain} and organization_id = ${orgA}`)[0]).toEqual({ company_id: owner.id, merged_company_id: merged.id });
    });

    it("declares both domain guard triggers", async () => {
      const rows = await sql`select tgname, tgrelid::regclass::text as tbl from pg_trigger where tgname in ('companies_domain_not_alias_trg', 'company_aliases_not_domain_trg') order by tgname`;
      expect(rows).toEqual([
        { tgname: "companies_domain_not_alias_trg", tbl: "companies" },
        { tgname: "company_aliases_not_domain_trg", tbl: "company_domain_aliases" },
      ]);
    });
  });

  describe("unmatched senders", () => {
    const exception = (status: string, person: string | null, resolved: boolean) =>
      sql<{ id: string }[]>`insert into identity_exceptions (organization_id, channel, account_ref, source_event_key, reason, status, resolved_person_id, resolved_at)
          values (${orgA}, 'email', 'me@a.test', ${uniqueKey()}, 'unknown_sender', ${status}, ${person}, ${resolved ? new Date().toISOString() : null}) returning id`;

    it("keeps a resolved unmatched sender resolved when its person is deleted", async () => {
      const person = await lead();
      const [{ id }] = await exception("resolved", person, true);
      await sql`delete from people where id = ${person}`;
      const [row] = await sql`select status, resolved_person_id, resolved_at from identity_exceptions where id = ${id}`;
      expect(row).toMatchObject({ status: "resolved", resolved_person_id: null });
      expect(row.resolved_at).not.toBeNull();
    });

    it("needs resolved_at on a resolved row, and no person on an open or ignored one", async () => {
      const person = await lead();
      expect(await rejection(exception("resolved", person, false))).toMatchObject({ constraint_name: "identity_exceptions_resolution_ck" });
      expect(await rejection(exception("resolved", null, false))).toMatchObject({ constraint_name: "identity_exceptions_resolution_ck" });
      expect(await rejection(exception("open", person, false))).toMatchObject({ constraint_name: "identity_exceptions_resolution_ck" });
      expect(await rejection(exception("ignored", person, true))).toMatchObject({ constraint_name: "identity_exceptions_resolution_ck" });
      await exception("resolved", person, true);
      await exception("resolved", null, true);
      await exception("open", null, false);
      await exception("ignored", null, true);
    });
  });

  describe("record assignee", () => {
    const assignee = async (id: string) => (await sql`select assigned_to, assigned_source from records where id = ${id}`)[0];

    it("accepts a member of the same organization and refuses anyone else", async () => {
      const id = await record();
      await sql`update records set assigned_to = ${bob}, assigned_source = 'human' where id = ${id}`;
      expect((await assignee(id)).assigned_to).toBe(bob);
      // Carl belongs to B, Dana to no organization, and a made-up id to no user at all.
      for (const outsider of [carl, dana, uid()]) {
        const error = await rejection(sql`update records set assigned_to = ${outsider}, assigned_source = 'human' where id = ${id}`);
        expect([error.code, error.constraint_name]).toEqual(["23503", "records_assigned_to_fk"]);
      }
    });

    it("requires a known source and a source whenever someone is assigned", async () => {
      const id = await record();
      const noSource = await rejection(sql`update records set assigned_to = ${ann} where id = ${id}`);
      expect([noSource.code, noSource.constraint_name]).toEqual(["23514", "records_assigned_source_ck"]);
      const badSource = await rejection(sql`update records set assigned_to = ${ann}, assigned_source = 'robot' where id = ${id}`);
      expect([badSource.code, badSource.constraint_name]).toEqual(["23514", "records_assigned_source_ck"]);
      await sql`update records set assigned_to = ${ann}, assigned_source = 'auto' where id = ${id}`;
      await sql`update records set assigned_to = null, assigned_source = 'cleared' where id = ${id}`;
      await sql`update records set assigned_to = null, assigned_source = null where id = ${id}`;
      await sql`update records set assigned_source = 'human' where id = ${id}`;
      expect(await assignee(id)).toEqual({ assigned_to: null, assigned_source: "human" });
    });

    it("unassigns the records of a member who leaves, keeps their organization, and leaves other members alone", async () => {
      const leaving = await user("Leaving");
      await sql`insert into members (organization_id, user_id, role) values (${orgA}, ${leaving}, 'member')`;
      const mine = await record();
      const theirs = await record();
      await sql`update records set assigned_to = ${leaving}, assigned_source = 'human' where id = ${mine}`;
      await sql`update records set assigned_to = ${ann}, assigned_source = 'auto' where id = ${theirs}`;

      await sql`delete from members where organization_id = ${orgA} and user_id = ${leaving}`;

      const [left] = await sql`select organization_id, assigned_to, assigned_source from records where id = ${mine}`;
      // The source keeps its old value. It is read only while assigned_to is set.
      expect(left).toEqual({ organization_id: orgA, assigned_to: null, assigned_source: "human" });
      expect((await assignee(theirs)).assigned_to).toBe(ann);
    });

    it("unassigns the records of a user who is deleted", async () => {
      const kept = await record();
      await sql`update records set assigned_to = ${ann}, assigned_source = 'human' where id = ${kept}`;
      const [{ id: temp }] = await sql<{ id: string }[]>`insert into users (name, email) values ('Temp', ${email()}) returning id`;
      await sql`insert into members (organization_id, user_id, role) values (${orgA}, ${temp}, 'member')`;
      const other = await record();
      await sql`update records set assigned_to = ${temp}, assigned_source = 'human' where id = ${other}`;
      await sql`delete from users where id = ${temp}`;
      expect((await assignee(other)).assigned_to).toBeNull();
      expect((await assignee(kept)).assigned_to).toBe(ann);
    });

    it("has the index the queue and the key read", async () => {
      const [index] = await sql`select pg_get_indexdef(indexrelid) as def from pg_index where indexrelid = 'records_org_assigned_idx'::regclass`;
      expect(index.def).toContain("ON public.records USING btree (organization_id, assigned_to, workflow_state)");
    });
  });
});
