import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { seedEmailEnrollment } from "./email-send-fixture";
import type { EngineDeps } from "../../email/application/send-next-email";
import type { Actor } from "@/shared/errors";
import { FakeMailboxProvider } from "../../email/infrastructure/fake-mailbox-provider";

describeDb("send status guard", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let engine: typeof import("../../email/application/send-next-email");
  let uc: typeof import("../../application/send-resolution");
  let stores: typeof import("../drizzle-management-stores");
  let outreachStore: typeof import("../drizzle-outreach-store").drizzleOutreachStore;
  const orgs: TestOrg[] = [];
  const start = new Date("2026-10-14T10:00:00Z");
  let current = start;
  const advance = (minutes: number) => {
    current = new Date(current.getTime() + minutes * 60_000);
  };

  async function fixture(behavior: "ok" | "refuse" | "timeout-lost" = "timeout-lost") {
    current = start;
    const { org, userId, mailbox, campaign, enrollment } = await seedEmailEnrollment(sql, orgs);
    const provider = new FakeMailboxProvider();
    provider.behavior = () => behavior;
    const deps: EngineDeps = { store: outreachStore, provider, clock: { now: () => current }, random: () => 0, appUrl: "https://app.test", unsubscribeSecret: "u".repeat(40) };
    // Every settle call is followed by the late calls of a slow worker. None of them may change the row.
    const late = async (claim: Parameters<typeof outreachStore.markFailed>[0]) => {
      await outreachStore.markSent(claim, { providerMessageId: "late-pm", threadId: "late-th" }, current);
      await outreachStore.markFailed(claim, "late failure", current, 5, 3);
      await outreachStore.markUnknown(claim, "late unknown");
      await outreachStore.abandon(claim, "suppressed", current);
    };
    const guarded = {
      ...outreachStore,
      markSent: async (...a: Parameters<typeof outreachStore.markSent>) => { await outreachStore.markSent(...a); await late(a[0]); },
      markFailed: async (...a: Parameters<typeof outreachStore.markFailed>) => { await outreachStore.markFailed(...a); await late(a[0]); },
      markUnknown: async (...a: Parameters<typeof outreachStore.markUnknown>) => { await outreachStore.markUnknown(...a); await late(a[0]); },
    };
    deps.store = guarded as typeof outreachStore;
    await engine.sendNextEmail(deps, mailbox);
    const [send] = await sql`select id from sends where enrollment_id = ${enrollment}`;
    const raw: EngineDeps = { ...deps, store: outreachStore };
    const admin: Actor = { userId, organizationId: org, role: "admin" };
    return { org, campaign, enrollment, mailbox, sendId: send.id as string, admin, provider, deps: raw, userId };
  }

  const row = async (id: string) => (await sql`select * from sends where id = ${id}`)[0];
  const enr = async (id: string) => (await sql`select * from campaign_enrollments where id = ${id}`)[0];
  const sendsDeps = () => ({ sends: stores.drizzleSendResolutionStore, now: () => current });

  beforeAll(async () => {
    engine = await import("../../email/application/send-next-email");
    uc = await import("../../application/send-resolution");
    stores = await import("../drizzle-management-stores");
    ({ drizzleOutreachStore: outreachStore } = await import("../drizzle-outreach-store"));
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("a late markFailed, markUnknown or abandon leaves a sent send sent, with one enrollment advance", async () => {
    const f = await fixture("ok");
    expect(await row(f.sendId)).toMatchObject({ status: "sent", provider_message_id: expect.any(String), error: null });
    expect(await enr(f.enrollment)).toMatchObject({ status: "active", current_step: 1 });
    expect(await row(f.sendId)).not.toMatchObject({ provider_message_id: "late-pm" });
  });

  it("a late markSent or markFailed leaves an unknown send unknown", async () => {
    const f = await fixture("timeout-lost");
    expect(await row(f.sendId)).toMatchObject({ status: "unknown", error: "Request timed out" });
    expect(await enr(f.enrollment)).toMatchObject({ current_step: 0 });
  });

  it("a late markSent leaves a failed send failed and does not advance the enrollment", async () => {
    const f = await fixture("refuse");
    const sent = await row(f.sendId);
    expect(sent).toMatchObject({ status: "failed", error: "Recipient address rejected" });
    expect(sent.provider_message_id).toBeNull();
    expect(await enr(f.enrollment)).toMatchObject({ current_step: 0 });
  });

  it("settles an unknown send once: reconcile after a person's answer changes nothing", async () => {
    const f = await fixture("timeout-lost");
    advance(60);
    await uc.resolveCampaignSend(sendsDeps(), f.admin, f.campaign, f.sendId, { outcome: "delivered" });
    await outreachStore.resolveUncertainAsNotSent({ sendId: f.sendId, enrollmentId: f.enrollment, stepNumber: 1, attempt: 1, nextStepWaitDays: 2 } as never, current, 5, 3);
    expect(await row(f.sendId)).toMatchObject({ status: "sent" });
  });

  it("test sends keep a final status against late writers", async () => {
    const f = await fixture("ok");
    const { drizzleTestSendStore } = await import("../../email/infrastructure/drizzle-test-send-store");
    const [{ id: user }] = await sql`select id from users where id = ${f.userId}`;
    const insert = async (status: string) =>
      (await sql`insert into sends (organization_id, kind, channel, status, mailbox_id, to_address, requested_by, claimed_at)
        values (${f.org}, 'test', 'email', ${status}, ${f.mailbox}, 'dev@example.com', ${user}, now()) returning id`)[0].id as string;
    const sentId = await insert("sending");
    await drizzleTestSendStore.markSent(sentId, { providerMessageId: "t1", threadId: null }, current);
    await drizzleTestSendStore.markFailed(sentId, "late");
    await drizzleTestSendStore.markUnknown(sentId, "late");
    await drizzleTestSendStore.abandon(sentId, "late");
    await drizzleTestSendStore.settle(sentId, { status: "failed", error: "late reconcile", now: current } as never);
    expect(await row(sentId)).toMatchObject({ status: "sent", error: null });

    const unknownId = await insert("sending");
    await drizzleTestSendStore.markUnknown(unknownId, "timeout");
    await drizzleTestSendStore.markSent(unknownId, { providerMessageId: "t2", threadId: null }, current);
    await drizzleTestSendStore.markFailed(unknownId, "late");
    expect(await row(unknownId)).toMatchObject({ status: "unknown", error: "timeout" });
    await drizzleTestSendStore.settle(unknownId, { status: "failed", error: "not found", now: current } as never);
    expect(await row(unknownId)).toMatchObject({ status: "failed", error: "not found" });
  });
});
