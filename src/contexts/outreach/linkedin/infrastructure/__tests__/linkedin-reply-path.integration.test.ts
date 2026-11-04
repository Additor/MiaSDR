import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";
import type { Actor } from "@/shared/errors";
import type { LinkedInInboundDeps } from "../../application/linkedin-ports";

/**
 * A reply on a LinkedIn campaign takes one path, from the webhook to the shared screens: it lands in the Inbox and its
 * unread count, moves the conversation into Actions, queues the AI, and stops the person's outreach on every campaign and channel.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("a reply on a LinkedIn campaign", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let inbound: typeof import("../../application/linkedin-inbound");
  let inboundStore: ReturnType<typeof import("../drizzle-linkedin-inbound-store").createDrizzleLinkedInInboundStore>;
  let parse: typeof import("../vendors/unipile/unipile-webhook").parseUnipilePayload;
  let campaignsApp: typeof import("../../application/linkedin-campaigns");
  let linkedinComposition: typeof import("../linkedin-composition");
  let inboxApp: typeof import("@/contexts/conversations/application/inbox");
  let inboxComposition: typeof import("@/contexts/conversations/infrastructure/composition");
  let unread: typeof import("@/contexts/conversations/infrastructure/drizzle-unread-store");
  let workQueueApp: typeof import("@/contexts/conversations/actions/application/work-queue");
  let workQueueComposition: typeof import("@/contexts/conversations/actions/infrastructure/work-queue-composition");
  let aiJobs: typeof import("@/contexts/conversations/ai/infrastructure/drizzle-ai-job-store");
  const orgs: string[] = [];
  const users: string[] = [];
  const clock = { now: () => new Date("2026-10-14T12:00:00Z") };
  const deps = (): LinkedInInboundDeps => ({ store: inboundStore, clock, parse });

  async function fixture() {
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('L', ${"lr-" + tag}) returning id`;
    orgs.push(org);
    const [{ id: creator }] = await sql`insert into users (name, email) values ('Creator', ${"creator-" + tag + "@x.test"}) returning id`;
    users.push(creator);
    await sql`insert into members (organization_id, user_id, role) values (${org}, ${creator}, 'owner')`;
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status)
      values (${org}, ${"acct-" + tag}, ${"ACo-owner-" + tag}, ${"owner-" + tag}, 'connected') returning id`;
    const actor: Actor = { userId: creator, organizationId: org, role: "owner" };
    return { org, tag, account, providerAccount: "acct-" + tag, actor };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const linkedinCampaign = async (f: Fixture, name: string) => (await campaignsApp.createLinkedInCampaign(linkedinComposition.linkedinCampaignDeps(), f.actor, { name })).id;

  /** A person with one active, connected LinkedIn enrollment on the fixture account. */
  async function lead(f: Fixture, campaignId: string) {
    const slug = `ada-${f.tag}`;
    const member = `ACo-${slug}`;
    const [{ id: person }] = await sql`insert into people (organization_id, linkedin_slug, email, first_name, full_name) values (${f.org}, ${slug}, ${slug + "@x.test"}, 'Ada', 'Ada Lovelace') returning id`;
    const [{ id: enrollment }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, linkedin_account_id)
      values (${f.org}, ${campaignId}, ${person}, 'linkedin', 'active', 1, ${f.account}) returning id`;
    await sql`
      insert into linkedin_enrollment_details (enrollment_id, organization_id, provider_id, profile_url, connection_state)
      values (${enrollment}, ${f.org}, ${member}, ${"https://www.linkedin.com/in/" + slug}, 'connected')`;
    return { person, member, slug, enrollment };
  }

  /** A person whose LinkedIn profile has not resolved: the enrollment has no member id yet. */
  async function unresolvedLead(f: Fixture, over: { slug?: boolean; rawMember?: boolean; otherAccount?: boolean }) {
    const campaignId = await linkedinCampaign(f, "Early");
    const tag = uniqueKey();
    const slug = `early-${tag}`;
    const member = `ACo-early-${tag}`;
    const [{ id: person }] = await sql`
      insert into people (organization_id, linkedin_slug, first_name, full_name, raw)
      values (${f.org}, ${over.slug === false ? null : slug}, 'Early', 'Early Bird', ${sql.json(over.rawMember ? { linkedin_member_id: member } : {})}) returning id`;
    let account: string | null = null;
    if (over.otherAccount) {
      [{ id: account }] = await sql`
        insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status)
        values (${f.org}, ${"acct2-" + f.tag}, ${"ACo-2-" + f.tag}, ${"owner2-" + f.tag}, 'connected') returning id`;
    }
    const [{ id: enrollment }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, linkedin_account_id)
      values (${f.org}, ${campaignId}, ${person}, 'linkedin', 'pending', 0, ${account}) returning id`;
    await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, profile_url, connection_state) values (${enrollment}, ${f.org}, ${"https://www.linkedin.com/in/" + slug}, 'none')`;
    return { person, slug, member, enrollment };
  }

  const receive = (f: Fixture, member: string, messageId: string, text: string, chat = "chat-" + member, profileUrl?: string) =>
    inbound.receiveLinkedInWebhook(deps(), {
      organizationId: f.org,
      payload: {
        event: "message_received",
        account_id: f.providerAccount,
        account_type: "LINKEDIN",
        account_info: { type: "LINKEDIN", user_id: "ACo-owner-" + f.tag },
        chat_id: chat,
        message_id: messageId,
        message: text,
        sender: { attendee_provider_id: member, ...(profileUrl ? { attendee_profile_url: profileUrl } : {}) },
        attendees: [{ attendee_provider_id: member }, { attendee_provider_id: "ACo-owner-" + f.tag }],
        timestamp: "2026-10-14T11:30:00.000Z",
      },
    });

  const statusOf = async (enrollment: string) => (await sql`select status from campaign_enrollments where id = ${enrollment}`)[0].status;
  const conversationOf = async (person: string) => (await sql`select * from conversations where person_id = ${person}`)[0];

  beforeAll(async () => {
    inbound = await import("../../application/linkedin-inbound");
    inboundStore = (await import("../drizzle-linkedin-inbound-store")).createDrizzleLinkedInInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
    ({ parseUnipilePayload: parse } = await import("../vendors/unipile/unipile-webhook"));
    campaignsApp = await import("../../application/linkedin-campaigns");
    linkedinComposition = await import("../linkedin-composition");
    inboxApp = await import("@/contexts/conversations/application/inbox");
    inboxComposition = await import("@/contexts/conversations/infrastructure/composition");
    unread = await import("@/contexts/conversations/infrastructure/drizzle-unread-store");
    workQueueApp = await import("@/contexts/conversations/actions/application/work-queue");
    workQueueComposition = await import("@/contexts/conversations/actions/infrastructure/work-queue-composition");
    aiJobs = await import("@/contexts/conversations/ai/infrastructure/drizzle-ai-job-store");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("reaches the Inbox, its unread count, the conversation, Actions and the AI queue", async () => {
    const f = await fixture();
    const ada = await lead(f, await linkedinCampaign(f, "Spring"));

    expect((await receive(f, ada.member, "m1", "Tell me more")).status).toBe("done");

    const list = await inboxApp.listInbox(inboxComposition.inboxDeps(), f.actor, {});
    expect(list.rows.map((row) => row.snippet)).toEqual(["Tell me more"]);
    expect(await unread.drizzleUnreadStore.counts(f.org)).toMatchObject({ total: 1, linkedin: 1 });

    const conversation = await conversationOf(ada.person);
    expect(conversation).toMatchObject({ workflow_state: "action_required", context_version: 1 });
    const queue = await workQueueApp.getWorkQueue(workQueueComposition.workQueueDeps(), f.actor);
    expect(Object.values(queue.groups).flatMap((group) => group.items.map((item) => item.conversationId))).toContain(conversation.id);

    await aiJobs.drizzleAiJobStore.enqueueMissing(new Date());
    expect((await sql`select kind from ai_jobs where organization_id = ${f.org}`).map((job) => job.kind)).toEqual(["classification"]);
  });

  it("stops the person's outreach on every campaign and channel, and no one else's", async () => {
    const f = await fixture();
    const first = await linkedinCampaign(f, "First");
    const second = await linkedinCampaign(f, "Second");
    const ada = await lead(f, first);
    const [{ id: onSecond }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, linkedin_account_id)
      values (${f.org}, ${second}, ${ada.person}, 'linkedin', 'active', 1, ${f.account}) returning id`;
    const [{ id: emailCampaign }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'email', 'Mail', 'active') returning id`;
    const [{ id: byEmail }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step)
      values (${f.org}, ${emailCampaign}, ${ada.person}, 'email', 'active', 1) returning id`;
    const [{ id: bystander }] = await sql`insert into people (organization_id, email) values (${f.org}, ${"bystander-" + f.tag + "@x.test"}) returning id`;
    const [{ id: theirs }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step)
      values (${f.org}, ${emailCampaign}, ${bystander}, 'email', 'active', 1) returning id`;

    await receive(f, ada.member, "m1", "Please call me");

    expect(await statusOf(ada.enrollment)).toBe("replied");
    expect(await statusOf(onSecond)).toBe("replied");
    expect(await statusOf(byEmail)).toBe("replied");
    expect(await statusOf(theirs)).toBe("active");
  });

  it("files a replayed delivery once, and the next message of the chat in the same conversation", async () => {
    const f = await fixture();
    const ada = await lead(f, await linkedinCampaign(f, "Spring"));
    await receive(f, ada.member, "m1", "First");
    await receive(f, ada.member, "m1", "First");
    await receive(f, ada.member, "m2", "Second");
    expect(await sql`select id from threads where organization_id = ${f.org}`).toHaveLength(1);
    expect(await sql`select id from messages where organization_id = ${f.org}`).toHaveLength(2);
  });

  describe("finds the lead before the profile resolved", () => {
    it("by profile slug, when the enrollment has no member id and no account yet", async () => {
      const f = await fixture();
      const early = await unresolvedLead(f, {});
      await receive(f, early.member, "e1", "Hi, saw your note", "chat-early", `https://www.linkedin.com/in/${early.slug}`);
      expect(await statusOf(early.enrollment)).toBe("replied");
      expect((await inboxApp.listInbox(inboxComposition.inboxDeps(), f.actor, {})).total).toBe(1);
    });

    it("by stored member id, when the reply carries no profile address", async () => {
      const f = await fixture();
      const early = await unresolvedLead(f, { slug: false, rawMember: true });
      await receive(f, early.member, "e2", "Hi", "chat-early-2");
      expect(await statusOf(early.enrollment)).toBe("replied");
    });

    it("when the enrollment sits on another account of the organization", async () => {
      const f = await fixture();
      const early = await unresolvedLead(f, { otherAccount: true });
      await receive(f, early.member, "e3", "Hi", "chat-early-3", `https://www.linkedin.com/in/${early.slug}`);
      expect(await statusOf(early.enrollment)).toBe("replied");
    });

    it("when the member id was resolved through another account and the reply carries no profile address", async () => {
      const f = await fixture();
      const early = await unresolvedLead(f, { slug: false, otherAccount: true });
      await sql`update linkedin_enrollment_details set provider_id = ${early.member} where enrollment_id = ${early.enrollment}`;
      await receive(f, early.member, "e5", "Hi", "chat-early-5");
      expect(await statusOf(early.enrollment)).toBe("replied");
    });

    it("and leaves a lead alone when a stranger writes", async () => {
      const f = await fixture();
      const early = await unresolvedLead(f, {});
      await receive(f, "ACo-stranger", "e4", "Who are you", "chat-stranger", "https://www.linkedin.com/in/someone-else");
      expect(await statusOf(early.enrollment)).toBe("pending");
      expect((await inboxApp.listInbox(inboxComposition.inboxDeps(), f.actor, {})).total).toBe(1);
    });
  });
});
