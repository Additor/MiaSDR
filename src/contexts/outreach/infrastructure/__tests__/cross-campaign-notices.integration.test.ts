import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { Actor } from "@/shared/errors";

const STEPS = [{ stepNumber: 1, kind: "invitation", body: "Hi", waitDays: 0 }];

describeDb("cross-campaign notices", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let notices: typeof import("../../linkedin/application/linkedin-enroll-notices");
  let reader: typeof import("../drizzle-cross-campaign-notices").drizzleCrossCampaignNotices;
  let deps: import("../../linkedin/application/linkedin-enroll-notices").NoticeDeps;
  const cleanup: string[] = [];

  async function fixture() {
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('N', ${"sn-" + tag}) returning id`;
    cleanup.push(org);
    const campaign = async (name: string) => {
      const [{ id }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${org}, 'linkedin', ${name}, 'active', ${sql.json(STEPS as never)}) returning id`;
      return id as string;
    };
    const person = async (name: string) => {
      const slug = `${name.toLowerCase().replace(/\W+/g, "-")}-${tag}`;
      const [first, ...rest] = name.split(" ");
      const [{ id }] = await sql`
        insert into people (organization_id, first_name, last_name, full_name, linkedin_slug, linkedin_url)
        values (${org}, ${first}, ${rest.join(" ") || null}, ${name}, ${slug}, ${`https://www.linkedin.com/in/${slug}/`}) returning id`;
      return id as string;
    };
    const account = async (name: string) => {
      const [{ id }] = await sql`
        insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, name, status)
        values (${org}, ${`a-${name}-${tag}`}, ${`ACo-${name}-${tag}`}, ${`u-${name}-${tag}`}, ${name}, 'connected') returning id`;
      return id as string;
    };
    const enroll = async (campaignId: string, personId: string, over: { status?: string; stopReason?: string; accountId?: string; sent?: boolean } = {}) => {
      const [{ id }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, stop_reason, linkedin_account_id, current_step)
        values (${org}, ${campaignId}, ${personId}, 'linkedin', ${over.status ?? "pending"}, ${over.stopReason ?? null}, ${over.accountId ?? null}, ${over.sent ? 1 : 0}) returning id`;
      await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, profile_url) values (${id}, ${org}, 'https://www.linkedin.com/in/x')`;
      if (over.sent && over.accountId) {
        await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id, sent_at) values (${org}, ${id}, 1, 'linkedin', 'sent', ${over.accountId}, now())`;
      }
      return id as string;
    };
    const actor: Actor = { userId: "00000000-0000-4000-8000-000000000000", organizationId: org, role: "member" };
    return { org, campaign, person, account, enroll, actor };
  }

  beforeAll(async () => {
    notices = await import("../../linkedin/application/linkedin-enroll-notices");
    ({ drizzleCrossCampaignNotices: reader } = await import("../drizzle-cross-campaign-notices"));
    const { linkedinNoticeDeps } = await import("../../linkedin/infrastructure/linkedin-composition");
    deps = linkedinNoticeDeps();
  });

  afterAll(async () => {
    try {
      await dropOrgs(sql, cleanup.map((organizationId) => ({ organizationId })));
    } finally {
      await sql.end();
    }
  });

  it("lists people already contacted in other campaigns when a query enrolls them", async () => {
    const f = await fixture();
    const [a, b] = [await f.campaign("Outbound Q3"), await f.campaign("Fresh list")];
    const acct = await f.account("Seller");
    const contacted = await f.person("Ada Lovelace");
    const replied = await f.person("Grace Hopper");
    const fresh = await f.person("Linus Torvalds");
    await f.enroll(a, contacted, { status: "active", accountId: acct, sent: true });
    await f.enroll(a, replied, { status: "replied" });

    const result = await notices.enrollLinkedInLeadsWithNotices(deps, f.actor, b, {});
    expect(result).toMatchObject({ added: 3, notices: { alreadyContactedPeople: 2, excludedByAccountPeople: 0 } });
    expect("addedPersonIds" in result).toBe(false);
    expect(result.notices.alreadyContacted.map((n) => [n.name, n.campaign.name, n.channel, n.status])).toEqual([
      ["Ada Lovelace", "Outbound Q3", "linkedin", "active"],
      ["Grace Hopper", "Outbound Q3", "linkedin", "replied"],
    ]);
    expect(result.notices.alreadyContacted.some((n) => n.personId === fresh)).toBe(false);
  });

  it("does not mention a person who is only queued elsewhere or was never sent to", async () => {
    const f = await fixture();
    const [a, b] = [await f.campaign("A"), await f.campaign("B")];
    const queued = await f.person("Queued Person");
    await f.enroll(a, queued, { status: "pending" });
    const result = await notices.enrollLinkedInLeadsWithNotices(deps, f.actor, b, {});
    expect(result.notices).toEqual({ alreadyContacted: [], alreadyContactedPeople: 0, excludedByAccount: [], excludedByAccountPeople: 0 });
  });

  it("covers the picked people in the picked form", async () => {
    const f = await fixture();
    const [a, b] = [await f.campaign("A"), await f.campaign("B")];
    const acct = await f.account("Seller");
    const one = await f.person("One Person");
    const two = await f.person("Two Person");
    await f.enroll(a, one, { status: "active", accountId: acct, sent: true });
    const result = await notices.enrollPickedLinkedInLeadsWithNotices(deps, f.actor, b, [one, two]);
    expect(result).toMatchObject({ added: 2 });
    expect(result.notices.alreadyContacted.map((n) => n.personId)).toEqual([one]);
  });

  it("names the account and the earlier campaign of a lead the account rule skipped, and leaves other leads out", async () => {
    const f = await fixture();
    const [a, b] = [await f.campaign("First wave"), await f.campaign("Second wave")];
    const acct = await f.account("Seller");
    const skipped = await f.person("Skipped Person");
    const other = await f.person("Other Person");
    await f.enroll(a, skipped, { status: "active", accountId: acct, sent: true });
    const skippedEnrollment = await f.enroll(b, skipped, { status: "suppressed", stopReason: "already_contacted_by_account", accountId: acct });
    await f.enroll(b, other, { status: "suppressed", stopReason: "do_not_contact" });

    const campaignWide = await reader.excludedByAccount(f.org, b, null);
    expect(campaignWide).toEqual({
      excludedByAccountPeople: 1,
      excludedByAccount: [{ enrollmentId: skippedEnrollment, personId: skipped, name: "Skipped Person", accountName: "Seller", campaign: { id: a, name: "First wave" } }],
    });
    expect((await reader.excludedByAccount(f.org, b, [other])).excludedByAccountPeople).toBe(0);
    expect((await reader.excludedByAccount(f.org, a, null)).excludedByAccountPeople).toBe(0);
  });

  it("changes no enrollment: the suppressed lead keeps its status and reason", async () => {
    const f = await fixture();
    const [a, b] = [await f.campaign("A"), await f.campaign("B")];
    const acct = await f.account("Seller");
    const p = await f.person("Same Person");
    await f.enroll(a, p, { status: "active", accountId: acct, sent: true });
    const e = await f.enroll(b, p, { status: "suppressed", stopReason: "already_contacted_by_account", accountId: acct });
    await reader.excludedByAccount(f.org, b, null);
    await reader.alreadyContacted(f.org, b, [p]);
    await reader.leadContext(f.org, b, [p]);
    expect((await sql`select status, stop_reason, next_send_at from campaign_enrollments where id = ${e}`)[0]).toMatchObject({ status: "suppressed", stop_reason: "already_contacted_by_account" });
  });

  it("gives the lead panel the other campaigns and the accounts that already invited the person", async () => {
    const f = await fixture();
    const [a, b] = [await f.campaign("Wave one"), await f.campaign("Wave two")];
    const acct = await f.account("Seller");
    const p = await f.person("Panel Person");
    const lonely = await f.person("Lonely Person");
    await f.enroll(a, p, { status: "active", accountId: acct, sent: true });
    await f.enroll(b, p, { status: "suppressed", stopReason: "already_contacted_by_account", accountId: acct });
    await f.enroll(b, lonely);

    const context = await reader.leadContext(f.org, b, [p, lonely]);
    expect(context.get(p)).toEqual({
      alsoInCampaigns: [{ campaignId: a, campaignName: "Wave one", channel: "linkedin", status: "active" }],
      excludedAccounts: [{ accountId: acct, accountName: "Seller", campaignName: "Wave one" }],
    });
    expect(context.get(lonely)).toBeUndefined();

    const { drizzleLinkedInCampaignStore } = await import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store");
    const list = await drizzleLinkedInCampaignStore.listEnrollments(f.org, b, { tab: "all", search: "", page: 1, pageSize: 50 });
    const row = list.rows.find((r) => r.personName === "Panel Person");
    expect(row?.detail.alsoInCampaigns.map((c) => c.campaignName)).toEqual(["Wave one"]);
    expect(row?.detail.excludedAccounts.map((x) => x.accountName)).toEqual(["Seller"]);
    expect(list.rows.find((r) => r.personName === "Lonely Person")?.detail).toMatchObject({ alsoInCampaigns: [], excludedAccounts: [] });
  });

  it("caps the listed rows and still counts every person", async () => {
    const f = await fixture();
    const [a, b] = [await f.campaign("A"), await f.campaign("B")];
    const acct = await f.account("Seller");
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const p = await f.person(`Person${String(i).padStart(2, "0")} Many`);
      ids.push(p);
      await f.enroll(a, p, { status: "active", accountId: acct, sent: true });
    }
    const out = await reader.alreadyContacted(f.org, b, ids);
    expect(out.alreadyContacted).toHaveLength(50);
    expect(out.alreadyContactedPeople).toBe(55);
  });

  it("does not see people of another organization", async () => {
    const f = await fixture();
    const g = await fixture();
    const [a, b] = [await g.campaign("Other A"), await g.campaign("Other B")];
    const p = await g.person("Foreign Person");
    await g.enroll(a, p, { status: "replied" });
    expect((await reader.alreadyContacted(f.org, b, [p])).alreadyContactedPeople).toBe(0);
    expect((await reader.leadContext(f.org, b, [p])).size).toBe(0);
  });
});
