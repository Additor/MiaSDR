import { drizzleEnrollmentAdminStore } from "../drizzle-enrollment-admin";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { seedEmailEnrollment } from "./email-send-fixture";
import type { EngineDeps } from "../../email/application/send-next-email";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { FakeMailboxProvider } from "../../email/infrastructure/fake-mailbox-provider";

describeDb("resolving unconfirmed email sends", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let engine: typeof import("../../email/application/send-next-email");
  let uc: typeof import("../../application/send-resolution");
  let campaignsUc: typeof import("../../application/campaign-management");
  let stores: typeof import("../drizzle-management-stores");
  let outreachStore: typeof import("../../email/infrastructure/drizzle-outreach-store").drizzleOutreachStore;
  const orgs: TestOrg[] = [];
  const start = new Date("2026-10-14T10:00:00Z");
  let current = start;
  const advance = (minutes: number) => {
    current = new Date(current.getTime() + minutes * 60_000);
  };

  async function fixture() {
    current = start;
    const { org, userId, mailbox, campaign, enrollment } = await seedEmailEnrollment(sql, orgs);
    const provider = new FakeMailboxProvider();
    provider.behavior = () => "timeout-lost";
    provider.findInconclusive = "Gmail search was truncated";
    const deps: EngineDeps = { store: outreachStore, provider, clock: { now: () => current }, random: () => 0, appUrl: "https://app.test", unsubscribeSecret: "u".repeat(40) };
    expect((await engine.sendNextEmail(deps, mailbox)).kind).toBe("unknown");
    advance(60);
    expect((await engine.reconcileUncertainSends(deps)).inconclusive).toBeGreaterThanOrEqual(1);
    const [send] = await sql`select id from sends where enrollment_id = ${enrollment}`;
    const admin: Actor = { userId, organizationId: org, role: "admin" };
    return { org, campaign, enrollment, mailbox, sendId: send.id as string, admin, provider, deps };
  }

  const row = async (id: string) => (await sql`select * from sends where id = ${id}`)[0];
  const enr = async (id: string) => (await sql`select * from campaign_enrollments where id = ${id}`)[0];
  const sendsDeps = () => ({ sends: stores.drizzleSendResolutionStore, now: () => current });

  beforeAll(async () => {
    engine = await import("../../email/application/send-next-email");
    uc = await import("../../application/send-resolution");
    campaignsUc = await import("../../application/campaign-management");
    stores = await import("../drizzle-management-stores");
    ({ drizzleOutreachStore: outreachStore } = await import("../../email/infrastructure/drizzle-outreach-store"));
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, orgs);
    } finally {
      await sql.end();
    }
  });

  it("lists the unknown send in the campaign detail and the campaigns list", async () => {
    const f = await fixture();
    const detail = { campaigns: stores.drizzleCampaignStore, mailboxes: stores.drizzleMailboxStore, admin: drizzleEnrollmentAdminStore, now: () => current };
    const d = await campaignsUc.getCampaignDetail(detail, f.admin, f.campaign, { tab: "all", search: "", page: 1, pageSize: 50 });
    expect(d.unconfirmed.total).toBe(1);
    expect(d.unconfirmed.rows[0]).toMatchObject({ sendId: f.sendId, stepNumber: 1, personName: "Lee Doe", note: "Request timed out" });
    expect((await campaignsUc.listCampaigns(detail, f.admin))[0].unconfirmed).toBe(1);
    // Younger than the 30 minute grace period: not listed.
    current = new Date(start.getTime() + 5 * 60_000);
    expect((await campaignsUc.getCampaignDetail(detail, f.admin, f.campaign, { tab: "all", search: "", page: 1, pageSize: 50 })).unconfirmed.total).toBe(0);
  });

  it("delivered: marks the send sent, advances the enrollment once, and the claim guard blocks a duplicate step", async () => {
    const f = await fixture();
    await uc.resolveCampaignSend(sendsDeps(), f.admin, f.campaign, f.sendId, { outcome: "delivered" });
    expect(await row(f.sendId)).toMatchObject({ status: "sent", provider_message_id: null });
    const e = await enr(f.enrollment);
    expect(e).toMatchObject({ status: "active", current_step: 1 });
    expect(e.next_send_at.getTime()).toBe(current.getTime() + 2 * 24 * 60 * 60_000);

    // A second answer is refused and changes nothing.
    await expect(uc.resolveCampaignSend(sendsDeps(), f.admin, f.campaign, f.sendId, { outcome: "delivered" })).rejects.toBeInstanceOf(ConflictError);
    expect((await enr(f.enrollment)).next_send_at.getTime()).toBe(e.next_send_at.getTime());

    // Step 1 is never claimed again. Step 2 goes out only once it is due.
    f.provider.behavior = () => "ok";
    advance(60);
    expect((await engine.sendNextEmail(f.deps, f.mailbox)).kind).toBe("idle");
    advance(3 * 24 * 60);
    expect((await engine.sendNextEmail(f.deps, f.mailbox)).kind).toBe("sent");
    expect(f.provider.delivered).toHaveLength(1);
    expect(f.provider.delivered[0].bodyText).toContain("Following up");
    const sends = await sql`select step_number, status from sends where enrollment_id = ${f.enrollment} order by step_number`;
    expect(sends.map((s) => `${s.step_number}:${s.status}`)).toEqual(["1:sent", "2:sent"]);
  });

  it("not delivered: needs the Sent folder confirmation, then makes the step retryable once", async () => {
    const f = await fixture();
    await expect(uc.resolveCampaignSend(sendsDeps(), f.admin, f.campaign, f.sendId, { outcome: "not_delivered" })).rejects.toBeInstanceOf(ValidationError);
    expect((await row(f.sendId)).status).toBe("unknown");

    await uc.resolveCampaignSend(sendsDeps(), f.admin, f.campaign, f.sendId, { outcome: "not_delivered", checkedSentFolder: true });
    expect(await row(f.sendId)).toMatchObject({ status: "failed", attempt: 1 });
    const e = await enr(f.enrollment);
    expect(e).toMatchObject({ status: "pending", current_step: 0 });
    await expect(uc.resolveCampaignSend(sendsDeps(), f.admin, f.campaign, f.sendId, { outcome: "not_delivered", checkedSentFolder: true })).rejects.toBeInstanceOf(ConflictError);

    f.provider.behavior = () => "ok";
    advance(24 * 60);
    expect((await engine.sendNextEmail(f.deps, f.mailbox)).kind).toBe("sent");
    expect(await row(f.sendId)).toMatchObject({ status: "sent", attempt: 2 });
    expect((await enr(f.enrollment)).current_step).toBe(1);
    expect(f.provider.delivered).toHaveLength(1);
  });

  it("two concurrent answers change the send once", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      uc.resolveCampaignSend(sendsDeps(), f.admin, f.campaign, f.sendId, { outcome: "delivered" }),
      uc.resolveCampaignSend(sendsDeps(), f.admin, f.campaign, f.sendId, { outcome: "delivered" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(ConflictError) });
    expect((await enr(f.enrollment)).current_step).toBe(1);
  });

  it("only an owner or admin may answer, and another organization gets a 404", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(uc.resolveCampaignSend(sendsDeps(), { ...f.admin, role: "member" }, f.campaign, f.sendId, { outcome: "delivered" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uc.resolveCampaignSend(sendsDeps(), other.admin, f.campaign, f.sendId, { outcome: "delivered" })).rejects.toBeInstanceOf(NotFoundError);
    // Right organization, wrong campaign.
    await expect(uc.resolveCampaignSend(sendsDeps(), f.admin, other.campaign, f.sendId, { outcome: "delivered" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(uc.resolveCampaignSend(sendsDeps(), f.admin, f.campaign, "not-a-uuid", { outcome: "delivered" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await row(f.sendId)).status).toBe("unknown");
    expect((await enr(f.enrollment)).current_step).toBe(0);
  });
});
