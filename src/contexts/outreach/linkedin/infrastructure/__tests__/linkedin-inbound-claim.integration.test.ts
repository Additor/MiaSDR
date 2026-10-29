import { afterAll, beforeAll, expect, it } from "vitest";
import { MAX_EVENT_ATTEMPTS } from "../../domain/linkedin";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. Calls the inbound store directly with its own clock. */

describeDb("LinkedIn inbound claim fence", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let store: ReturnType<typeof import("../drizzle-linkedin-inbound-store").createDrizzleLinkedInInboundStore>;
  let operations: typeof import("../drizzle-linkedin-operations-store").drizzleLinkedInOperationsStore;
  let inbound: typeof import("../../application/linkedin-inbound");
  const orgs: TestOrg[] = [];
  const LEASE_SECONDS = 300;
  const start = new Date("2026-10-14T10:00:00Z");
  /** Moments far enough apart that each lease and each retry wait has run out by the next one. */
  const at = (n: number) => new Date(start.getTime() + n * 3_600_000);

  beforeAll(async () => {
    store = (await import("../drizzle-linkedin-inbound-store")).createDrizzleLinkedInInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
    operations = (await import("../drizzle-linkedin-operations-store")).drizzleLinkedInOperationsStore;
    inbound = await import("../../application/linkedin-inbound");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  async function delivery() {
    const created = await createTestOrg(sql, "Inbound claim", "admin");
    orgs.push(created);
    const org = created.organizationId;
    const claim = await store.begin({ organizationId: org, key: `unipile:message_received:v1:${uniqueKey()}`, eventType: "message_received", accountRef: "acc-1", payload: { text: "hi" }, now: at(0) });
    if (!claim) throw new Error("begin found a duplicate");
    return { org, claim };
  }
  const row = async (id: string) => (await sql`select status, attempts, claim_token, lease_until, log from inbound_events where id = ${id}`)[0];

  it("writes a fresh token on every claim and clears it when the claim ends", async () => {
    const { org, claim } = await delivery();
    expect(claim.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    expect((await row(claim.id)).claim_token).toBe(claim.claimToken);
    const [again] = await store.claimReplayable(at(1), 10, LEASE_SECONDS, org);
    expect(again).toMatchObject({ id: claim.id, attempts: 2 });
    expect(again.claimToken).not.toBe(claim.claimToken);
    await store.finish(again, "done", null, at(1));
    expect(await row(claim.id)).toMatchObject({ status: "done", claim_token: null });
  });

  it("a worker whose lease ran out cannot settle the row after an admin requeue and a new claim", async () => {
    const { org, claim: first } = await delivery();
    // The lease ran out: the replay job claims attempt 2 and fails it.
    const [second] = await store.claimReplayable(at(1), 10, LEASE_SECONDS, org);
    await store.fail(second, "gave up", at(1), null);
    expect(await operations.requeueFailedWebhooks(org, at(1), 10)).toBe(1);
    const [third] = await store.claimReplayable(at(2), 10, LEASE_SECONDS, org);
    // The requeue reset the attempts, so the new claim carries the attempt number of the first one.
    expect(third.attempts).toBe(first.attempts);
    await store.fail(first, "late failure", at(2), null);
    await store.finish(first, "skipped", "late finish", at(2));
    expect(await row(first.id)).toMatchObject({ status: "processing", attempts: 1, claim_token: third.claimToken });
  });

  it("an admin requeue clears the token of a failed row", async () => {
    const { org, claim } = await delivery();
    await sql`update inbound_events set status = 'failed', lease_until = null where id = ${claim.id}`;
    expect(await operations.requeueFailedWebhooks(org, at(1), 10)).toBe(1);
    expect(await row(claim.id)).toMatchObject({ status: "failed", attempts: 0, claim_token: null });
  });

  it("a processing row whose lease ran out on the last attempt turns failed, so an admin can replay it", async () => {
    const { org, claim } = await delivery();
    await sql`update inbound_events set attempts = ${MAX_EVENT_ATTEMPTS} where id = ${claim.id}`;
    // The replay tick fails it first and reports it; no claim takes it.
    const report = await inbound.replayLinkedInEvents({ store, clock: { now: () => at(1) }, parse: () => null }, 10, org);
    expect(report).toEqual({ stopped: 1, claimed: 0, done: 0, failed: 0 });
    const dead = await row(claim.id);
    expect(dead).toMatchObject({ status: "failed", attempts: MAX_EVENT_ATTEMPTS, claim_token: null, lease_until: null });
    expect(dead.log.at(-1)).toMatchObject({ level: "error", message: "The worker stopped during the last attempt." });
    expect(await operations.webhookBacklog(org)).toMatchObject({ dead: 1 });
    expect(await operations.requeueFailedWebhooks(org, at(1), 10)).toBe(1);
    expect(await store.claimReplayable(at(2), 10, LEASE_SECONDS, org)).toMatchObject([{ id: claim.id, attempts: 1 }]);
  });

  it("a processing row at the cap whose lease still runs stays with its worker", async () => {
    const { org, claim } = await delivery();
    await sql`update inbound_events set attempts = ${MAX_EVENT_ATTEMPTS} where id = ${claim.id}`;
    // One minute into the five minute lease.
    const now = new Date(at(0).getTime() + 60_000);
    expect(await store.failStoppedAtCap(now, org)).toBe(0);
    expect(await store.claimReplayable(now, 10, LEASE_SECONDS, org)).toEqual([]);
    expect(await row(claim.id)).toMatchObject({ status: "processing", attempts: MAX_EVENT_ATTEMPTS, claim_token: claim.claimToken });
  });
});
