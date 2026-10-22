import { afterAll, beforeAll, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { ConflictError, ValidationError } from "@/shared/errors";
import { bootDealsKit, holdLocks, waitForLockWaiters, type DealsKit } from "@/test-support/deals-test-kit";
import type { AddContactDeps, AddContactInput } from "../../application/add-contact";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * Add contact ("Contacts and Companies CRUD" in docs/decisions.md) against the real store and the real
 * conversations event writer: a contact with `converted_at`, the replay by key, the email and LinkedIn matches, a unique
 * conflict that reads its own key first, and the company rules. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("add contact", () => {
  let kit: DealsKit;
  let app: typeof import("../../application/add-contact");
  let deps: AddContactDeps;
  let dbClient: typeof import("@/platform/db/client");

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    app = await import("../../application/add-contact");
    dbClient = await import("@/platform/db/client");
    const { drizzleContactStore } = await import("../drizzle-contact-store");
    const { appendPersonEvent } = await import("@/contexts/conversations/infrastructure/person-handling");
    deps = { contacts: drizzleContactStore, appendEvent: appendPersonEvent };
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  let n = 0;
  const key = () => `key-${Date.now()}-${++n}`;
  const add = (actor: Actor, input: Partial<AddContactInput>) => dbClient.db.transaction((tx) => app.addContact(deps, tx, actor, { creationKey: key(), ...input }));
  const errorOf = (run: Promise<unknown>) => run.then(() => null, (e: unknown) => e);
  const personRow = async (id: string) => kit.one("select * from people where id = $1", [id]);

  it("creates a contact with converted_at, source manual, the creation key and a contact.added event", async () => {
    const f = await kit.organization();
    const creationKey = key();
    const result = await add(f.member, { firstName: "Ada", lastName: "Kim", email: `ADA-${f.tag}@acme.test`, linkedinUrl: "linkedin.com/in/Ada-K", title: "CTO", creationKey });
    expect(result.replayed).toBe(false);
    const row = await personRow(result.personId);
    expect(row).toMatchObject({
      lifecycle: "contact",
      source: "manual",
      creation_key: creationKey,
      email: `ada-${f.tag}@acme.test`,
      linkedin_slug: "ada-k",
      linkedin_url: "https://www.linkedin.com/in/ada-k/",
      full_name: "Ada Kim",
      title: "CTO",
      company_id: null,
    });
    expect(row.converted_at).not.toBeNull();
    const events = await kit.sql`select event_type, actor_type, actor_user_id from events where person_id = ${result.personId}`;
    expect(events).toEqual([{ event_type: "contact.added", actor_type: "human", actor_user_id: f.member.userId }]);
  });

  it("replays a repeat with the same key", async () => {
    const f = await kit.organization();
    const creationKey = key();
    const first = await add(f.member, { email: `r-${f.tag}@acme.test`, creationKey });
    expect(await add(f.member, { email: `r-${f.tag}@acme.test`, creationKey })).toEqual({ personId: first.personId, replayed: true });
    expect(await kit.count("people", f.org)).toBe(1);
  });

  it("answers lead_exists for the email, then contact_exists, and writes nothing", async () => {
    const f = await kit.organization();
    const lead = await f.person({ name: "Lena Lead", email: `lena-${f.tag}@acme.test` });
    const error = (await errorOf(add(f.member, { email: `LENA-${f.tag}@acme.test`, firstName: "Typed" }))) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe(`Lena Lead (lena-${f.tag}@acme.test) is already a lead.`);
    expect(error.details).toEqual({ code: "lead_exists", personId: lead, name: "Lena Lead", email: `lena-${f.tag}@acme.test`, others: [] });

    const contact = await f.person({ name: null, email: `cora-${f.tag}@acme.test`, contact: true });
    const second = (await errorOf(add(f.member, { email: `cora-${f.tag}@acme.test` }))) as ConflictError;
    expect(second.message).toBe(`cora-${f.tag}@acme.test is already a contact.`);
    expect(second.details).toMatchObject({ code: "contact_exists", personId: contact });
    expect(await kit.count("people", f.org)).toBe(2);
    expect((await personRow(lead)).first_name).toBeNull();
  });

  it("matches the LinkedIn profile when no email matches, and names a second match in others", async () => {
    const f = await kit.organization();
    const [{ id: bySlug }] = await kit.sql`insert into people (organization_id, full_name, linkedin_slug, linkedin_url) values (${f.org}, 'Sam Slug', ${`sam-${f.tag}`}, ${`https://www.linkedin.com/in/sam-${f.tag}/`}) returning id`;
    const slugOnly = (await errorOf(add(f.member, { linkedinUrl: `linkedin.com/in/sam-${f.tag}` }))) as ConflictError;
    expect(slugOnly.details).toMatchObject({ code: "lead_exists", personId: bySlug, others: [] });

    const byEmail = await f.person({ name: "Erin Email", email: `erin-${f.tag}@acme.test`, contact: true });
    const both = (await errorOf(add(f.member, { email: `erin-${f.tag}@acme.test`, linkedinUrl: `linkedin.com/in/sam-${f.tag}` }))) as ConflictError;
    expect(both.details).toEqual({
      code: "contact_exists",
      personId: byEmail,
      name: "Erin Email",
      email: `erin-${f.tag}@acme.test`,
      others: [{ personId: bySlug, name: "Sam Slug", lifecycle: "lead", linkedinUrl: `https://www.linkedin.com/in/sam-${f.tag}/` }],
    });
  });

  it("re-reads its own key first after a unique conflict, then the identity", async () => {
    const f = await kit.organization();
    const creationKey = key();
    const email = `race-${f.tag}@acme.test`;
    // The same dialog's first request, still uncommitted on another connection.
    const first = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`insert into people (organization_id, email, lifecycle, converted_at, creation_key, source) values (${f.org}, ${email}, 'contact', now(), ${creationKey}, 'manual')`);
    const replaying = add(f.member, { email, creationKey });
    await waitForLockWaiters(kit.sql, 1);
    await first.release();
    const replay = await replaying;
    expect(replay.replayed).toBe(true);
    expect(replay.personId).toBe((await kit.one("select id from people where creation_key = $1", [creationKey])).id);

    // Another dialog won the email: the loser answers contact_exists.
    const other = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`insert into people (organization_id, email, lifecycle, converted_at, creation_key, source) values (${f.org}, ${`other-${email}`}, 'contact', now(), ${key()}, 'manual')`);
    const losing = errorOf(add(f.member, { email: `other-${email}` }));
    await waitForLockWaiters(kit.sql, 1);
    await other.release();
    expect(((await losing) as ConflictError).details).toMatchObject({ code: "contact_exists" });
    expect(await kit.count("people", f.org)).toBe(2);
  });

  it("joins an existing company by domain or other domain, refuses a rename, and creates a new one with the typed name", async () => {
    const f = await kit.organization();
    const acme = await f.company("Acme", `acme-${f.tag}.test`);
    await kit.sql`insert into company_domain_aliases (organization_id, company_id, domain) values (${f.org}, ${acme}, ${`globex-${f.tag}.test`})`;

    const joined = await add(f.member, { email: `j-${f.tag}@acme.test`, companyDomain: `www.acme-${f.tag}.test`, companyName: "Acme" });
    expect((await personRow(joined.personId)).company_id).toBe(acme);
    const viaAlias = await add(f.member, { email: `g-${f.tag}@acme.test`, companyDomain: `globex-${f.tag}.test` });
    expect((await personRow(viaAlias.personId)).company_id).toBe(acme);

    const rename = await errorOf(add(f.member, { email: `x-${f.tag}@acme.test`, companyDomain: `acme-${f.tag}.test`, companyName: "Acme Inc" }));
    expect(rename).toBeInstanceOf(ValidationError);
    expect((rename as Error).message).toBe("Rename Acme on its company page.");
    expect(await kit.count("people", f.org, `email = 'x-${f.tag}@acme.test'`)).toBe(0);

    const fresh = await add(f.member, { email: `n-${f.tag}@acme.test`, companyDomain: `initech-${f.tag}.test`, companyName: "Initech" });
    const [initech] = await kit.sql`select id, name from companies where organization_id = ${f.org} and domain = ${`initech-${f.tag}.test`}`;
    expect(initech.name).toBe("Initech");
    expect((await personRow(fresh.personId)).company_id).toBe(initech.id);
    const [{ meta }] = await kit.sql`select meta from events where person_id = ${fresh.personId}`;
    expect(meta).toEqual({ companyId: initech.id });
  });

  it("answers 422 for no identity, a webmail domain and a short key", async () => {
    const f = await kit.organization();
    expect(((await errorOf(add(f.member, { firstName: "Ada" }))) as Error).message).toBe("A contact needs an email or a LinkedIn profile.");
    expect(((await errorOf(add(f.member, { email: `w-${f.tag}@acme.test`, companyDomain: "gmail.com" }))) as Error).message).toBe("gmail.com is an email provider, not a company domain.");
    expect(((await errorOf(add(f.member, { email: `k-${f.tag}@acme.test`, creationKey: "short" }))) as Error).message).toBe("Send an idempotency key of 8 to 200 characters.");
    expect(await kit.count("people", f.org)).toBe(0);
  });

  it("keeps organizations apart", async () => {
    const a = await kit.organization();
    const b = await kit.organization();
    await b.person({ email: `shared-${a.tag}@acme.test` });
    const result = await add(a.member, { email: `shared-${a.tag}@acme.test` });
    expect((await personRow(result.personId)).organization_id).toBe(a.org);
  });
});
