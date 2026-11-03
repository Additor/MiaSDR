import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";
import { seedWorld, type World } from "@/test-support/full-world";

/**
 * The lead detail the lead page and the contact page read: people's fields with the outreach and conversations facts
 * (enrollments, sends, the Inbox conversation). Pinned on the full-world fixture. Needs TEST_DATABASE_URL pointing at a
 * migrated Postgres.
 */
describeDb("lead detail", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let leads: typeof import("@/composition/leads");
  let w: World;

  beforeAll(async () => {
    leads = await import("@/composition/leads");
    w = await seedWorld(sql);
  });

  afterAll(async () => {
    await dropOrgs(sql, [{ organizationId: w.org, userId: w.user }]);
    await sql.end();
  });

  const read = () => leads.leadRepository.get(w.org, w.person);

  it("shows the enrollments, the conversation and the people fields", async () => {
    const detail = await read();
    expect(detail?.person).toMatchObject({ id: w.person, email: `${w.tag}@lead.test`, fullName: "Lead", lifecycle: "lead" });
    expect(detail?.enrollments.map((e) => e.id)).toEqual([w.enrollment]);
    expect(detail?.enrollments[0]).toMatchObject({ campaignId: w.campaign, campaignName: "c", campaignStatus: "draft", channel: "email", status: "pending", currentStep: 0 });
    expect(detail?.threadId).toBe(w.thread);
    expect(detail?.policy).toBeNull();
    expect(detail?.suppression).toBeNull();
  });

  it("lists the campaign sends, each with its step", async () => {
    const detail = await read();
    expect(detail?.sends.map((s) => s.id).sort()).toEqual([w.sendEmail, w.sendLinkedin].sort());
    expect(detail?.sends.every((s) => typeof s.stepNumber === "number")).toBe(true);
  });

  it("finds nothing under another organization", async () => {
    const [{ id }] = await sql`insert into organizations (name, slug) values ('X', ${"x-" + w.tag}) returning id`;
    try {
      expect(await leads.leadRepository.get(id, w.person)).toBeNull();
    } finally {
      await dropOrgs(sql, [{ organizationId: id }]);
    }
  });
});
