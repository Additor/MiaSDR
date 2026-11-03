import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestOrg, describeDb, dropOrgs, testSql, useTestEnv, type TestOrg } from "@/test-support/db";
import { enableMcp, mcpCaller, type McpCaller } from "@/test-support/mcp-fixture";
import { ENROLL_BLOCK_REASONS, ENROLL_BLOCKS, NO_ENROLL_SKIPS, type EnrollBlock } from "../../domain/enrollment-eligibility";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));

/**
 * Each bucket of the enroll rule through each entry point: a person's search and picks, an agent's `add_leads`, the Tables
 * handoff and the LinkedIn search sink. Every preview must answer what its enroll then does.
 */
type Channel = "email" | "linkedin";

describeDb("one enrollment rule", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let org: TestOrg;
  let email: typeof import("../../application/campaign-management");
  let linkedin: typeof import("../../linkedin/application/linkedin-campaigns");
  let emailDeps: ReturnType<typeof import("../composition").campaignDeps>;
  let linkedinDeps: ReturnType<typeof import("../../linkedin/infrastructure/linkedin-composition").linkedinCampaignDeps>;
  let found: typeof import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store").enrollFoundPeople;
  let handoff: typeof import("@/contexts/grid/infrastructure/campaign-handoff").campaignHandoff;
  let POST: (request: Request) => Promise<Response>;
  let agent: McpCaller;
  let n = 0;

  const actor = () => ({ organizationId: org.organizationId, userId: org.userId, role: "owner" as const });
  const tag = () => `p${(n += 1)}x${Math.random().toString(36).slice(2, 8)}`;

  async function campaign(channel: Channel) {
    const [{ id }] = await sql<{ id: string }[]>`insert into campaigns (organization_id, channel, name, status, steps) values (${org.organizationId}, ${channel}, ${tag()}, 'draft', ${sql.json([])}) returning id`;
    return id;
  }

  async function person(search: string, over: { email?: string | null; slug?: string | null; contact?: boolean } = {}) {
    const t = tag();
    const [{ id }] = await sql<{ id: string }[]>`
      insert into people (organization_id, first_name, full_name, email, linkedin_slug, lifecycle, converted_at)
      values (${org.organizationId}, ${t}, ${`${search} ${t}`}, ${over.email === undefined ? `${t}@acme.test` : over.email}, ${over.slug === undefined ? t : over.slug}, ${over.contact ? "contact" : "lead"}, ${over.contact ? new Date().toISOString() : null})
      returning id`;
    return id;
  }

  const enroll = (campaignId: string, personId: string, channel: Channel, status: string) =>
    sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${org.organizationId}, ${campaignId}, ${personId}, ${channel}, ${status})`;

  const suppress = async (personId: string, reason: string) =>
    sql`insert into suppression_list (organization_id, email, reason) select organization_id, lower(email), ${reason} from people where id = ${personId}`;

  /** A person with an open stop request: the latest reply's words asked, and no person reviewed it. */
  async function askedToStop(personId: string) {
    const [{ email: address }] = await sql<{ email: string }[]>`select email from people where id = ${personId}`;
    const { ingestInbound } = await import("@/contexts/conversations/infrastructure/composition");
    const t = tag();
    await ingestInbound({
      organizationId: org.organizationId,
      accountRef: "me@acme.test",
      providerThreadId: t,
      providerMessageId: t,
      rfcMessageId: `<${t}@x.test>`,
      inReplyTo: null,
      from: { email: address, name: "Lena" },
      to: ["me@acme.test"],
      subject: "Re: Hello",
      bodyText: "Please stop emailing me.",
      receivedAt: new Date(),
      autoReply: false,
    });
  }

  /** One person per bucket, one that passes, and two that fit more than one reason, each under `search`. */
  async function everyBucket(channel: Channel, campaignId: string, search: string) {
    const noIdentity = await person(search, channel === "email" ? { email: null } : { slug: null });
    const removed = await person(search);
    await enroll(campaignId, removed, channel, "removed");
    const duplicate = await person(search);
    await enroll(campaignId, duplicate, channel, "active");
    const suppressed = await person(search);
    await suppress(suppressed, "unsubscribed");
    const dnc = await person(search);
    await sql`insert into contact_policies (organization_id, person_id, do_not_contact, source, set_at) values (${org.organizationId}, ${dnc}, true, 'human', now())`;
    const stop = await person(search);
    await askedToStop(stop);
    const contact = await person(search, { contact: true });
    const ok = await person(search);
    // Two reasons, counted once under the first: these two buckets used to count the same person twice.
    const duplicateAndSuppressed = await person(search);
    await enroll(campaignId, duplicateAndSuppressed, channel, "active");
    await suppress(duplicateAndSuppressed, "manual");
    const suppressedContact = await person(search, { contact: true });
    await suppress(suppressedContact, "unsubscribed");
    return { ids: [noIdentity, removed, duplicate, suppressed, dnc, stop, contact, ok, duplicateAndSuppressed, suppressedContact], ok };
  }

  const restoreLeads = async (channel: Channel, campaignId: string, enrollmentId: string) => {
    const { enrollmentRestore } = await import("@/composition/inbox-filing");
    const { restoreCampaignEnrollments } = await import("../../application/enrollment-restore");
    return restoreCampaignEnrollments(enrollmentRestore(), actor(), channel, campaignId, [enrollmentId]);
  };

  const expectedSkips = { ...NO_ENROLL_SKIPS, skippedMissingIdentity: 1, skippedRemoved: 1, skippedDuplicate: 2, skippedSuppressed: 2, skippedDoNotContact: 1, skippedStopRequest: 1, skippedContact: 1 };
  const skipsOf = (counts: object) => Object.fromEntries(Object.keys(NO_ENROLL_SKIPS).map((key) => [key, (counts as Record<string, number>)[key]]));
  const enrolledCount = async (campaignId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from campaign_enrollments where campaign_id = ${campaignId} and status = 'pending'`)[0].n;

  beforeAll(async () => {
    org = await createTestOrg(sql, "E");
    email = await import("../../application/campaign-management");
    linkedin = await import("../../linkedin/application/linkedin-campaigns");
    emailDeps = (await import("../composition")).campaignDeps();
    linkedinDeps = (await import("../../linkedin/infrastructure/linkedin-composition")).linkedinCampaignDeps();
    found = (await import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store")).enrollFoundPeople;
    handoff = (await import("@/contexts/grid/infrastructure/campaign-handoff")).campaignHandoff;
    ({ POST } = await import("@/app/api/mcp/route"));
    await enableMcp(sql, org.organizationId);
    agent = await mcpCaller(sql, POST, org, ["mcp:read", "mcp:write"]);
  }, 120_000);

  afterAll(async () => {
    try {
      await dropOrgs(sql, [org]);
    } finally {
      await sql.end();
    }
  });

  describe.each(["email", "linkedin"] as const)("%s", (channel) => {
    const pick = (campaignId: string, ids: string[], dryRun: boolean) =>
      channel === "email" ? email.enrollPickedLeads(emailDeps, actor(), campaignId, ids, { dryRun }) : linkedin.enrollPickedLinkedInLeads(linkedinDeps, actor(), campaignId, ids, { dryRun });
    const search = (campaignId: string, query: string, dryRun: boolean) =>
      channel === "email" ? email.enrollLeads(emailDeps, actor(), campaignId, { query, dryRun }) : linkedin.enrollLinkedInLeads(linkedinDeps, actor(), campaignId, { query, dryRun });

    it("a search and its dry run answer the same counts, every person in one bucket", async () => {
      const c = await campaign(channel);
      const word = tag();
      await everyBucket(channel, c, word);
      const preview = await search(c, word, true);
      expect(preview).toMatchObject({ requested: 10, added: 0, wouldAdd: 1 });
      expect(skipsOf(preview)).toEqual(expectedSkips);
      expect(await enrolledCount(c)).toBe(0);

      const real = await search(c, word, false);
      expect(real).toMatchObject({ requested: 10, added: 1 });
      expect(skipsOf(real)).toEqual(expectedSkips);
      expect(await enrolledCount(c)).toBe(1);
    });

    it("picks and their dry run answer the same counts, an unknown id included", async () => {
      const c = await campaign(channel);
      const { ids } = await everyBucket(channel, c, tag());
      const named = [...ids, "00000000-0000-4000-8000-000000000000"];
      const preview = await pick(c, named, true);
      expect(preview).toMatchObject({ requested: 11, added: 0, wouldAdd: 1, skippedNotFound: 1 });
      expect(skipsOf(preview)).toEqual(expectedSkips);
      expect(await enrolledCount(c)).toBe(0);

      const real = await pick(c, named, false);
      expect(real).toMatchObject({ requested: 11, added: 1, skippedNotFound: 1 });
      expect(skipsOf(real)).toEqual(expectedSkips);
    });

    it("a search and picks of the same people agree", async () => {
      const [bySearch, byPick] = [await campaign(channel), await campaign(channel)];
      const word = tag();
      await everyBucket(channel, bySearch, word);
      const { ids } = await everyBucket(channel, byPick, tag());
      expect(skipsOf(await search(bySearch, word, true))).toEqual(skipsOf(await pick(byPick, ids, true)));
    });

    it("an agent's add_leads answers what a person's enroll answers, dry run or not", async () => {
      const c = await campaign(channel);
      const { ids } = await everyBucket(channel, c, tag());
      const named = (over: object) => agent.tool("draft_campaign", { action: "add_leads", channel, campaignId: c, personIds: ids, ...over });
      const expected = { missingIdentity: 1, removed: 1, duplicate: 2, suppressed: 2, doNotContact: 1, stopRequest: 1, contact: 1 };
      const preview = await named({ dryRun: true });
      expect(preview.structured).toMatchObject({ enroll: { dryRun: true, requested: 10, added: 0, wouldAdd: 1, skipped: expected } });
      const real = await named({});
      expect(real.structured).toMatchObject({ enroll: { dryRun: false, requested: 10, added: 1, skipped: expected } });
    });
  });

  it("the LinkedIn search sink enrolls only who the rule lets through", async () => {
    const c = await campaign("linkedin");
    const { ids, ok } = await everyBucket("linkedin", c, tag());
    expect(await found(org.organizationId, c, ids)).toEqual({ added: 1, skippedContact: 1 });
    const [{ person_id }] = await sql<{ person_id: string }[]>`select person_id from campaign_enrollments where campaign_id = ${c} and status = 'pending'`;
    expect(person_id).toBe(ok);
  });

  describe.each(["email", "linkedin"] as const)("the Tables handoff on %s", (channel) => {
    it("reports each bucket's reason per row and enrolls the rest", async () => {
      const c = await campaign(channel);
      const word = tag();
      const { ids, ok } = await everyBucket(channel, c, word);
      // Every person but the one without the channel's identity; a row without it stops at the cell check before the rule.
      const rows = await sql<{ id: string; email: string | null; linkedin_slug: string | null }[]>`select id, email, linkedin_slug from people where id in ${sql(ids)}`;
      const withIdentity = rows.filter((row) => (channel === "email" ? row.email : row.linkedin_slug));
      const report = await handoff.push({
        organizationId: org.organizationId,
        userId: org.userId,
        tableId: "00000000-0000-4000-8000-000000000000",
        tableName: "t",
        target: { campaignId: c },
        columns: [
          { key: "e", name: "Email" },
          { key: "l", name: "LinkedIn" },
        ],
        fields: channel === "email" ? { email: "e" } : { linkedin: "l" },
        customColumnKeys: [],
        rows: withIdentity.map((row) => ({ id: row.id, cells: channel === "email" ? { e: row.email } : { l: `https://www.linkedin.com/in/${row.linkedin_slug}` } })),
      });
      expect(report.enrolled).toBe(1);
      const reasons = report.failures.map((failure) => failure.reason).sort();
      const row = (block: EnrollBlock) => ENROLL_BLOCK_REASONS[block].row(channel);
      // A suppressed address in the row's own cell stops before the import, so it never becomes a lead. On email that reads
      // first for the person who is also a duplicate; a LinkedIn row carries no address to check.
      const both = channel === "email" ? row("suppressed") : row("duplicate");
      expect(reasons).toEqual([row("removed"), row("duplicate"), both, row("suppressed"), row("suppressed"), row("do_not_contact"), row("stop_request"), row("contact")].sort());
      const [{ person_id }] = await sql<{ person_id: string }[]>`select person_id from campaign_enrollments where campaign_id = ${c} and status = 'pending'`;
      expect(person_id).toBe(ok);
    });
  });

  describe("which suppression reasons reach LinkedIn", () => {
    it.each([
      ["unsubscribed", 0, 1],
      ["manual", 0, 1],
      ["complaint", 0, 1],
      ["bounced", 1, 0],
    ])("%s", async (reason, added, skipped) => {
      const [li, mail] = [await campaign("linkedin"), await campaign("email")];
      const p = await person(tag());
      await suppress(p, reason);
      expect(await linkedin.enrollPickedLinkedInLeads(linkedinDeps, actor(), li, [p])).toMatchObject({ added, skippedSuppressed: skipped });
      expect(await email.enrollPickedLeads(emailDeps, actor(), mail, [p])).toMatchObject({ added: 0, skippedSuppressed: 1 });

      // A restore reads the same reasons: a person removed earlier comes back exactly when a new enrollment would take them.
      const back = await person(tag());
      await suppress(back, reason);
      const [liBack, mailBack] = [await campaign("linkedin"), await campaign("email")];
      const [{ id: removedLi }] = await sql<{ id: string }[]>`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${org.organizationId}, ${liBack}, ${back}, 'linkedin', 'removed') returning id`;
      const [{ id: removedMail }] = await sql<{ id: string }[]>`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${org.organizationId}, ${mailBack}, ${back}, 'email', 'removed') returning id`;
      expect(await restoreLeads("linkedin", liBack, removedLi)).toMatchObject(added ? { restored: 1, refused: [] } : { restored: 0, refused: [{ reason: "suppressed" }] });
      expect(await restoreLeads("email", mailBack, removedMail)).toMatchObject({ restored: 0, refused: [{ reason: "suppressed" }] });
    });

    it("a bounced address someone then unsubscribes closes LinkedIn too", async () => {
      const { suppressAddressTx } = await import("@/contexts/people/infrastructure/reachability");
      const { db } = await import("@/platform/db/client");
      const p = await person(tag());
      await suppress(p, "bounced");
      const [{ email: address }] = await sql<{ email: string }[]>`select email from people where id = ${p}`;
      expect(await suppressAddressTx(db, { organizationId: org.organizationId, email: address, reason: "unsubscribed" })).toEqual({ email: address, added: false });
      const [{ reason }] = await sql<{ reason: string }[]>`select reason from suppression_list where organization_id = ${org.organizationId} and email = ${address}`;
      expect(reason).toBe("unsubscribed");
      // A later bounce changes nothing: the request to be left alone still holds.
      await suppressAddressTx(db, { organizationId: org.organizationId, email: address, reason: "bounced" });
      expect((await sql<{ reason: string }[]>`select reason from suppression_list where organization_id = ${org.organizationId} and email = ${address}`)[0].reason).toBe("unsubscribed");
    });
  });

  it("the campaign list counts what the campaign page counts", async () => {
    const c = await campaign("email");
    for (const status of ["pending", "replied", "completed", "bounced", "suppressed", "failed", "cancelled", "removed"]) await enroll(c, await person(tag()), "email", status);
    const row = (await email.listCampaigns(emailDeps, actor())).find((item) => item.id === c);
    const page = await email.getCampaignDetail(emailDeps, actor(), c, { tab: "all", search: "", page: 1, pageSize: 20 });
    expect(row).toMatchObject({ enrolled: page.enrollments.counts.all, stopped: page.enrollments.counts.stopped, replied: 1, completed: 1 });
    expect(row).toMatchObject({ enrolled: 7, stopped: 4 });
  });

  it("the reason table has a bucket for every block, and no two blocks share one", () => {
    expect(new Set(ENROLL_BLOCKS.map((block) => ENROLL_BLOCK_REASONS[block].bucket)).size).toBe(ENROLL_BLOCKS.length);
  });
});
