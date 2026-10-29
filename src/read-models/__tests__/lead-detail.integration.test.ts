import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";
import { seedWorld, type World } from "@/test-support/full-world";

/**
 * The lead detail the lead page and the contact page read: people's fields with the outreach and conversations facts
 * (enrollments, sends, the Inbox conversation, the hidden-sends flag). Pinned on the full-world fixture plus personal
 * campaigns of two members, for each kind of viewer. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("lead detail", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let leads: typeof import("@/composition/leads");
  let w: World;
  let other: string;
  const extra: Record<string, string> = {};

  beforeAll(async () => {
    leads = await import("@/composition/leads");
    w = await seedWorld(sql);
    const one = async (rows: PromiseLike<Array<{ id: string }>>) => (await rows)[0].id;
    other = await one(sql`insert into users (name, email) values ('O', ${"o-" + w.tag + "@t8.test"}) returning id`);
    // The viewer's own personal campaign and another member's, each with a sent step to the lead.
    for (const [key, owner] of [["mine", w.user], ["theirs", other]] as const) {
      const campaign = await one(sql`insert into campaigns (organization_id, channel, name, status, type, created_by) values (${w.org}, 'linkedin', ${key}, 'active', 'personal', ${owner}) returning id`);
      const enrollment = await one(sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${w.org}, ${campaign}, ${w.person}, 'linkedin', 'active') returning id`);
      extra[`${key}Campaign`] = campaign;
      extra[`${key}Send`] = await one(sql`
        insert into sends (organization_id, enrollment_id, step_number, channel, linkedin_account_id, status, sent_at, claimed_at)
        values (${w.org}, ${enrollment}, 1, 'linkedin', ${w.linkedinAccount}, 'sent', now(), now() + interval '1 minute') returning id`);
    }
    // A private thread updated later than the public one: the Inbox link stays on the public conversation.
    await sql`insert into conversations (organization_id, record_id, channel, account_ref, private_campaign_id, updated_at)
      values (${w.org}, ${w.record}, 'linkedin', ${"pv-" + w.tag}, ${extra.mineCampaign}, now() + interval '1 day')`;
  });

  afterAll(async () => {
    await dropOrgs(sql, [{ organizationId: w.org, userId: w.user }], [other]);
    await sql.end();
  });

  const read = (viewer?: { userId: string; seesAllPersonal: boolean }) => leads.leadRepository.get(w.org, w.person, viewer);

  it("shows regular enrollments only, the public conversation and the people fields", async () => {
    const detail = await read({ userId: w.user, seesAllPersonal: false });
    expect(detail?.person).toMatchObject({ id: w.person, email: `${w.tag}@lead.test`, fullName: "Lead", lifecycle: "lead" });
    expect(detail?.enrollments.map((e) => e.id)).toEqual([w.enrollment]);
    expect(detail?.enrollments[0]).toMatchObject({ campaignId: w.campaign, campaignName: "c", campaignStatus: "draft", channel: "email", status: "pending", currentStep: 0 });
    expect(detail?.conversationId).toBe(w.conversation);
    expect(detail?.policy).toBeNull();
    expect(detail?.suppression).toBeNull();
  });

  it("lists the sends each viewer may see and flags the rest", async () => {
    const regular = [w.sendEmail, w.sendLinkedin].sort();
    const ids = (d: Awaited<ReturnType<typeof read>>) => d?.sends.map((s) => s.id).sort();
    const none = await read();
    expect(ids(none)).toEqual(regular);
    expect(none?.hiddenSends).toBe(true);
    const member = await read({ userId: w.user, seesAllPersonal: false });
    expect(ids(member)).toEqual([...regular, extra.mineSend].sort());
    expect(member?.hiddenSends).toBe(true);
    const admin = await read({ userId: other, seesAllPersonal: true });
    expect(ids(admin)).toEqual([...regular, extra.mineSend, extra.theirsSend].sort());
    expect(admin?.hiddenSends).toBe(false);
    // Newest claim first (the personal steps were claimed a minute later), and every campaign send carries its step.
    expect(admin?.sends.slice(0, 2).map((s) => s.id).sort()).toEqual([extra.mineSend, extra.theirsSend].sort());
    expect(admin?.sends.every((s) => typeof s.stepNumber === "number")).toBe(true);
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
