import { afterAll, beforeAll, expect, it } from "vitest";
import { NotFoundError } from "@/shared/errors";
import { bootDealsKit, holdLocks, waitForLockWaiters, type DealsKit } from "../../../../test-support/deals-test-kit";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * Create deal in contact mode while a contact delete runs ("Contacts and Companies CRUD" in docs/decisions.md). The delete
 * holds the people row; the deal insert's foreign key check waits on it and fails with 23503 on `deals_person_fk` once the
 * delete commits. `createDealForContact` answers 404 "This contact no longer exists." for that, not a 500.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("create deal for contact", () => {
  let kit: DealsKit;
  let deals: typeof import("../../application/deals");
  let composition: typeof import("@/composition/deals");

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    deals = await import("../../application/deals");
    composition = await import("@/composition/deals");
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  it("answers 404 when a delete of the contact commits while the deal insert waits", async () => {
    const f = await kit.organization();
    // A contact with no history yet, so a plain delete goes through (events.person_id is RESTRICT).
    const personId = await f.person({ name: "Gone Soon", contact: true });
    await composition.dealsDeps().store.listStages(f.org);
    const holder = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`delete from people where id = ${personId}`);
    const pending = deals.createDealForContact(composition.dealsDeps(), f.owner, personId, { idempotencyKey: "race-key-1" }).then(
      () => null,
      (error: unknown) => error,
    );
    await waitForLockWaiters(kit.sql, 1);
    await holder.release();
    const error = await pending;
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as Error).message).toBe("This contact no longer exists.");
    expect(await kit.count("deals", f.org)).toBe(0);
    expect(await kit.count("people", f.org)).toBe(0);
  });

  it("still answers 404 for a contact that was gone before the call", async () => {
    const f = await kit.organization();
    const personId = await f.person({ name: "Already gone", contact: true });
    await kit.sql`delete from people where id = ${personId}`;
    await expect(deals.createDealForContact(composition.dealsDeps(), f.owner, personId, { idempotencyKey: "race-key-3" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
