import { afterAll, beforeAll, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/shared/errors";
import type { AddContactWithDealDeps } from "../../application/deal-ports";
import { bootDealsKit, type DealsKit, type DealsOrg } from "../../../../test-support/deals-test-kit";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * Add contact with "Also create a deal" ("Contacts and Companies CRUD" in docs/decisions.md). The test wires the real leads
 * `addContact` as the `CreateContact` port, as the composition root does: the contact and its deal commit together, a repeat
 * with the same key replays both, and a deal that fails leaves no person. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("add contact with deal", () => {
  let kit: DealsKit;
  let deals: typeof import("../../application/deals");
  let deps: (overrides?: Partial<AddContactWithDealDeps>) => AddContactWithDealDeps;

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    deals = await import("../../application/deals");
    const composition = await import("@/composition/deals");
    const { dealTitleParts } = await import("../person-deals");
    const { addContact } = await import("@/contexts/people/application/add-contact");
    const { drizzleContactStore } = await import("@/contexts/people/infrastructure/drizzle-contact-store");
    const { appendPersonEvent } = await import("@/contexts/conversations/infrastructure/person-handling");
    deps = (overrides = {}) => ({
      ...composition.dealsDeps(),
      createContact: (tx, actor, input) => addContact({ contacts: drizzleContactStore, appendEvent: appendPersonEvent }, tx, actor, input),
      dealTitleParts,
      ...overrides,
    });
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  let n = 0;
  const key = () => `add-deal-${Date.now()}-${++n}`;
  const errorOf = (run: Promise<unknown>) => run.then(() => null, (e: unknown) => e);
  const peopleOf = (f: DealsOrg) => kit.count("people", f.org);

  it("creates the contact and its deal in one transaction, with the default title and both events", async () => {
    const f = await kit.organization();
    const idempotencyKey = key();
    const result = await deals.addContactWithDeal(deps(), f.member, {
      firstName: "Ada",
      lastName: "Kim",
      email: `ada-${f.tag}@acme.test`,
      companyDomain: `acme-${f.tag}.test`,
      companyName: "Acme",
      deal: { amount: "1,250.50", currency: "USD" },
      idempotencyKey,
    });
    expect(result.replayed).toBe(false);
    const person = await kit.one("select lifecycle, converted_at, creation_key, company_id from people where id = $1", [result.personId]);
    expect(person).toMatchObject({ lifecycle: "contact", creation_key: idempotencyKey });
    expect(person.converted_at).not.toBeNull();
    const deal = await kit.one("select person_id, title, owner_user_id, amount_minor, currency, idempotency_key, source_enrollment_id from deals where id = $1", [result.dealId]);
    expect(deal).toMatchObject({ person_id: result.personId, title: "Acme, Ada Kim", owner_user_id: f.member.userId, currency: "USD", idempotency_key: idempotencyKey, source_enrollment_id: null });
    expect(Number(deal.amount_minor)).toBe(125050);
    const events = await kit.sql`select event_type, meta from events where person_id = ${result.personId} order by created_at, id`;
    // Both events come from one transaction and share `now()`, so their order is not defined.
    expect(events.map((e) => e.event_type).sort()).toEqual(["contact.added", "deal.created"]);
    expect(events.find((e) => e.event_type === "deal.created")?.meta).toMatchObject({ dealId: result.dealId, title: "Acme, Ada Kim", converted: false });
  });

  it("replays a repeat with the same key: one person, one deal", async () => {
    const f = await kit.organization();
    const idempotencyKey = key();
    const input = { email: `r-${f.tag}@acme.test`, deal: { title: "Renewal" }, idempotencyKey };
    const first = await deals.addContactWithDeal(deps(), f.owner, input);
    expect(await deals.addContactWithDeal(deps(), f.owner, input)).toEqual({ personId: first.personId, dealId: first.dealId, replayed: true });
    expect(await peopleOf(f)).toBe(1);
    expect(await kit.count("deals", f.org)).toBe(1);
  });

  it("creates the deal on a repeat whose first call added the contact only", async () => {
    const f = await kit.organization();
    const idempotencyKey = key();
    const contact = { email: `late-${f.tag}@acme.test`, idempotencyKey };
    const { createContact } = deps();
    const { db } = await import("@/platform/db/client");
    const added = await db.transaction((tx) => createContact(tx, f.owner, { email: contact.email, creationKey: idempotencyKey }));
    const result = await deals.addContactWithDeal(deps(), f.owner, contact);
    expect(result).toMatchObject({ personId: added.personId, replayed: false });
    expect(await kit.count("deals", f.org)).toBe(1);
  });

  it("leaves no person when the deal insert fails", async () => {
    const f = await kit.organization();
    const base = deps();
    const failing = deps({ store: { ...base.store, insert: async () => Promise.reject(new Error("deal insert failed")) } });
    await expect(deals.addContactWithDeal(failing, f.owner, { email: `fail-${f.tag}@acme.test`, idempotencyKey: key() })).rejects.toThrow("deal insert failed");
    expect(await peopleOf(f)).toBe(0);
    expect(await kit.count("companies", f.org)).toBe(0);
  });

  it("leaves no person for a stage of no pipeline, and checks the owner and the key before it writes", async () => {
    const f = await kit.organization();
    const stranger = "00000000-0000-4000-8000-000000000000";
    const stage = await errorOf(deals.addContactWithDeal(deps(), f.owner, { email: `s-${f.tag}@acme.test`, companyDomain: `s-${f.tag}.test`, deal: { stageId: stranger }, idempotencyKey: key() }));
    expect(stage).toBeInstanceOf(ValidationError);
    expect((stage as Error).message).toBe("Pick a stage of this pipeline.");
    await expect(deals.addContactWithDeal(deps(), f.owner, { email: `o-${f.tag}@acme.test`, deal: { ownerId: stranger }, idempotencyKey: key() })).rejects.toThrow("The owner must be a member");
    await expect(deals.addContactWithDeal(deps(), f.owner, { email: `k-${f.tag}@acme.test`, idempotencyKey: "short" })).rejects.toThrow("Send an idempotency key of 8 to 200 characters.");
    expect(await peopleOf(f)).toBe(0);
    expect(await kit.count("companies", f.org)).toBe(0);
  });

  it("answers Add contact's lead_exists and writes no deal", async () => {
    const f = await kit.organization();
    const lead = await f.person({ name: "Lena Lead", email: `lena-${f.tag}@acme.test` });
    const error = (await errorOf(deals.addContactWithDeal(deps(), f.owner, { email: `lena-${f.tag}@acme.test`, idempotencyKey: key() }))) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.details).toMatchObject({ code: "lead_exists", personId: lead });
    expect(await kit.count("deals", f.org)).toBe(0);
    expect(await peopleOf(f)).toBe(1);
  });
});
