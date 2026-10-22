import { afterAll, beforeAll, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@/shared/errors";
import { lockRetryStats } from "@/platform/db/errors";
import { bootDealsKit, holdLocks, type DealsKit } from "@/test-support/deals-test-kit";
import type { MakeContactDeps } from "../../application/make-contact";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * Make contact ("Contacts and Companies CRUD" in docs/decisions.md), the conversion without a deal, wired here as the
 * composition root will wire it: the conversion ports of conversations and outreach, the live-enrollment read and a transaction
 * with the conversion's lock timeout. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("make contact", () => {
  let kit: DealsKit;
  let app: typeof import("../../application/make-contact");
  let deps: MakeContactDeps;

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    app = await import("../../application/make-contact");
    const { conversionDeps } = await import("@/contexts/deals/infrastructure/deals-composition");
    const { conversionOutreach } = await import("@/contexts/outreach/infrastructure/drizzle-conversion-outreach");
    const { personTransaction } = await import("../drizzle-contact-store");
    deps = { ...conversionDeps, liveEnrollmentSummary: conversionOutreach.liveEnrollmentSummary, transaction: personTransaction };
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  const errorOf = (run: Promise<unknown>) => run.then(() => null, (e: unknown) => e);
  const lifecycle = async (id: string) => (await kit.one("select lifecycle, converted_at from people where id = $1", [id])).lifecycle as string;

  it("makes a lead a contact without a deal, stops its enrollments and writes reason added", async () => {
    const f = await kit.organization();
    const p = await f.person();
    const enrollment = await f.enrollment(await f.campaign(), p, "active");
    const result = await app.makeContact(deps, f.member, p);
    expect(result).toEqual({ personId: p, stopped: { enrollments: 1, runs: 0, drafts: 0 } });
    expect(await lifecycle(p)).toBe("contact");
    expect(await kit.one("select status, stop_reason from campaign_enrollments where id = $1", [enrollment])).toEqual({ status: "cancelled", stop_reason: "converted" });
    const events = await kit.sql`select event_type, actor_user_id, meta from events where person_id = ${p}`;
    expect(events).toEqual([{ event_type: "lifecycle.converted", actor_user_id: f.member.userId, meta: { reason: "added", stopped: { enrollments: 1, runs: 0, drafts: 0 } } }]);
    expect(await kit.count("deals", f.org)).toBe(0);
  });

  it("answers already_converted for a contact", async () => {
    const f = await kit.organization();
    const p = await f.person({ contact: true });
    const error = (await errorOf(app.makeContact(deps, f.member, p))) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.details).toEqual({ code: "already_converted", personId: p });
  });

  it("answers 409 personal_campaign to a member while another member's personal campaign reaches the lead", async () => {
    const f = await kit.organization();
    const p = await f.person();
    await f.enrollment(await f.campaign({ type: "personal", createdBy: f.creator.userId }), p, "active", "linkedin");
    const error = (await errorOf(app.makeContact(deps, f.member, p))) as ConflictError;
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.details).toEqual({ code: "personal_campaign" });
    expect(error.message).toBe("A personal campaign of another member is still reaching this person. Its creator or an admin can create the deal.");
    expect(await lifecycle(p)).toBe("lead");

    expect((await app.makeContact(deps, f.creator, p)).personId).toBe(p);
    const other = await f.person();
    await f.enrollment(await f.campaign({ type: "personal", createdBy: f.creator.userId }), other, "active", "linkedin");
    await app.makeContact(deps, f.owner, other);
    expect(await lifecycle(other)).toBe("contact");
  });

  it("gives way to a held person row, retries once and answers try_again", async () => {
    const f = await kit.organization();
    const p = await f.person();
    const retries = lockRetryStats.retries;
    const gate = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`select id from people where id = ${p} for update`);
    const error = (await errorOf(app.makeContact(deps, f.member, p))) as ConflictError;
    await gate.release();
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.details).toEqual({ code: "try_again" });
    expect(lockRetryStats.retries).toBe(retries + 1);
    expect(await lifecycle(p)).toBe("lead");
    expect(await kit.count("events", f.org)).toBe(0);
  });

  it("answers 404 for an unknown id, another organization's lead and a malformed id", async () => {
    const a = await kit.organization();
    const b = await kit.organization();
    const theirs = await b.person();
    await expect(app.makeContact(deps, a.member, theirs)).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.makeContact(deps, a.member, "00000000-0000-4000-8000-000000000001")).rejects.toBeInstanceOf(NotFoundError);
    await expect(app.makeContact(deps, a.member, "nope")).rejects.toBeInstanceOf(NotFoundError);
    expect(await lifecycle(theirs)).toBe("lead");
  });
});
