import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, TEST_DATABASE_URL, testSql, useTestEnv, waitForLockWaiters, type TestOrg } from "@/test-support/db";

/**
 * Bulk Mark do not contact (`setPeopleDoNotContact`) and the 404 of `setDoNotContact` for a person deleted under it
 * ("Contacts and Companies CRUD" in docs/decisions.md). Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("do not contact: bulk marks and a person deleted under the mark", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  let replies: typeof import("../../application/reply-handling");
  let deps: import("../../application/reply-handling").ReplyHandlingDeps;
  const orgs: TestOrg[] = [];

  beforeAll(async () => {
    replies = await import("../../application/reply-handling");
    deps = (await import("../reply-handling-composition")).replyHandlingDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  async function fixture() {
    const created = await createTestOrg(sql, "Dnc", "member");
    orgs.push(created);
    const { organizationId: org, userId: user, slug: tag } = created;
    const actor: Actor = { userId: user, organizationId: org, role: "member" };
    let n = 0;
    const person = async () => {
      const [{ id }] = await sql`insert into people (organization_id, email) values (${org}, ${`p${++n}-${tag}@lead.test`}) returning id`;
      return id as string;
    };
    return { org, actor, person };
  }

  const marked = async (personId: string) => (await sql`select do_not_contact from contact_policies where person_id = ${personId}`)[0]?.do_not_contact ?? false;

  it("marks each person once and reports the rest, so the numbers add up to the distinct ids", async () => {
    const f = await fixture();
    const fresh = [await f.person(), await f.person()];
    const already = await f.person();
    await replies.setPersonDoNotContact(deps, f.actor, already, { enabled: true, reason: "asked earlier" });
    const elsewhere = await fixture();
    const foreign = await elsewhere.person();
    const missing = "00000000-0000-4000-8000-000000000000";
    const ids = [...fresh, fresh[0], already, missing, "not-a-uuid", foreign];

    const report = await replies.setPeopleDoNotContact(deps, f.actor, ids, { reason: "  wrong person " });

    expect(report.marked).toBe(2);
    expect(report.skipped).toEqual([
      { personId: already, reason: "already_marked" },
      { personId: missing, reason: "not_found" },
      { personId: "not-a-uuid", reason: "not_found" },
      { personId: foreign, reason: "not_found" },
    ]);
    expect(report.marked + report.skipped.length).toBe(new Set(ids).size);
    for (const id of fresh) expect(await marked(id)).toBe(true);
    expect(await marked(foreign)).toBe(false);
    const [policy] = await sql`select reason from contact_policies where person_id = ${fresh[1]}`;
    expect(policy.reason).toBe("wrong person");
    const [event] = await sql`select actor_user_id, to_data from events where person_id = ${fresh[0]} and event_type = 'contact_policy.dnc_set'`;
    expect(event).toMatchObject({ actor_user_id: f.actor.userId, to_data: { doNotContact: true, reason: "wrong person" } });
  });

  it("refuses an empty batch, more than 200 ids and a missing reason", async () => {
    const f = await fixture();
    const id = await f.person();
    await expect(replies.setPeopleDoNotContact(deps, f.actor, [], { reason: "x" })).rejects.toBeInstanceOf(ValidationError);
    const many = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await expect(replies.setPeopleDoNotContact(deps, f.actor, many, { reason: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(replies.setPeopleDoNotContact(deps, f.actor, [id], { reason: "   " })).rejects.toThrow("Say why this person should not be contacted.");
    expect(await marked(id)).toBe(false);
  });

  it("stops starting people after the time budget and reports the rest as retryable", async () => {
    const f = await fixture();
    const ids = [await f.person(), await f.person(), await f.person()];
    let clock = Date.parse("2026-10-19T10:00:00Z");
    // Each person's mark reads the clock once for `now`; the loop reads it once before each person.
    const slow = { ...deps, now: () => new Date((clock += replies.BULK_DNC_TIME_BUDGET_MS / 3)) };

    const report = await replies.setPeopleDoNotContact(slow, f.actor, ids, { reason: "asked" });

    expect(report.marked).toBe(1);
    expect(report.skipped).toEqual([
      { personId: ids[1], reason: "retryable" },
      { personId: ids[2], reason: "retryable" },
    ]);
    expect(await marked(ids[1])).toBe(false);
  });

  it("answers 404, not 500, when the person is deleted between the read and the mark", async () => {
    const f = await fixture();
    const id = await f.person();
    const holder = postgres(TEST_DATABASE_URL ?? "", { max: 1, onnotice: () => undefined });
    try {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      // Hold the do-not-contact lock, so the mark reads the person and then waits.
      const held = holder.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`dnc:${id}`}, 0))`;
        locked();
        await released;
        await tx`delete from people where id = ${id}`;
      });
      await Promise.race([lockTaken, held]);
      const mark = replies.setPersonDoNotContact(deps, f.actor, id, { enabled: true, reason: "asked" });
      const outcome = mark.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await waitForLockWaiters(sql, 1);
      } finally {
        release();
      }
      await held;
      const error = await outcome;
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as Error).message).toBe("Person not found");
      expect((await sql`select count(*)::int as n from contact_policies where person_id = ${id}`)[0].n).toBe(0);
    } finally {
      await holder.end();
    }
  });

  it("reports a person deleted before the bulk mark reaches them as not found", async () => {
    const f = await fixture();
    const kept = await f.person();
    const gone = await f.person();
    await sql`delete from people where id = ${gone}`;
    const report = await replies.setPeopleDoNotContact(deps, f.actor, [kept, gone], { reason: "asked" });
    expect(report).toEqual({ marked: 1, skipped: [{ personId: gone, reason: "not_found" }] });
  });
});
