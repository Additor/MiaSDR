import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, waitForLockWaiters } from "@/test-support/db";
import { ConflictError, ForbiddenError, NotFoundError, type Actor } from "@/shared/errors";
import type { LinkedInInboundDeps } from "../../application/linkedin-ports";
import type { WorkingHours } from "@/contexts/outreach/domain/working-hours";

/**
 * Personal campaigns (DB-005). A reply to a personal campaign stays out of the Inbox, its counts, the CRM and the AI,
 * still stops every active enrollment of the person, and can be read from the campaign by an owner, an admin or the creator.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));

describeDb("personal campaigns", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let inbound: typeof import("../../application/linkedin-inbound");
  let inboundStore: ReturnType<typeof import("../drizzle-linkedin-inbound-store").createDrizzleLinkedInInboundStore>;
  let parse: typeof import("../unipile-webhook").parseUnipilePayload;
  let campaignsApp: typeof import("../../application/linkedin-campaigns");
  let linkedinComposition: typeof import("../linkedin-composition");
  let personal: typeof import("../../application/personal-thread");
  let inboxApp: typeof import("@/contexts/conversations/application/inbox");
  let inboxComposition: typeof import("@/contexts/conversations/infrastructure/composition");
  let unread: typeof import("@/contexts/conversations/infrastructure/drizzle-unread-store");
  let crmApp: typeof import("@/contexts/conversations/application/crm");
  let crmComposition: typeof import("@/contexts/conversations/infrastructure/crm-composition");
  let workQueueApp: typeof import("@/contexts/conversations/actions/application/work-queue");
  let workQueueComposition: typeof import("@/contexts/conversations/actions/infrastructure/work-queue-composition");
  let personHandling: typeof import("@/contexts/conversations/infrastructure/person-handling").personReplyHandling;
  let dealsApp: typeof import("@/contexts/deals/application/deals");
  let dealsComposition: typeof import("@/composition/deals");
  let aiJobs: typeof import("@/contexts/conversations/ai/infrastructure/drizzle-ai-job-store");
  let replyStore: typeof import("@/contexts/conversations/infrastructure/drizzle-reply-store");
  let linkedinReplyStore: typeof import("@/contexts/conversations/infrastructure/drizzle-linkedin-reply-store");
  const orgs: string[] = [];
  const users: string[] = [];
  const clock = { now: () => new Date("2026-10-14T12:00:00Z") };
  const deps = (): LinkedInInboundDeps => ({ store: inboundStore, clock, parse });

  async function fixture() {
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('P', ${"pc-" + tag}) returning id`;
    orgs.push(org);
    const [{ id: creator }] = await sql`insert into users (name, email) values ('Creator', ${"creator-" + tag + "@x.test"}) returning id`;
    users.push(creator);
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status)
      values (${org}, ${"acct-" + tag}, ${"ACo-owner-" + tag}, ${"owner-" + tag}, 'connected') returning id`;
    const actor = (role: string, userId = creator): Actor => ({ userId, organizationId: org, role });
    return { org, tag, creator, account, providerAccount: "acct-" + tag, actor };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function campaign(f: Fixture, type: "regular" | "personal") {
    const { id } = await campaignsApp.createLinkedInCampaign(linkedinComposition.linkedinCampaignDeps(), f.actor("owner"), { name: `${type} campaign`, type });
    return id;
  }

  async function enrollLead(f: Fixture, person: string, member: string, slug: string, campaignId: string) {
    const [{ id }] = await sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, linkedin_account_id)
      values (${f.org}, ${campaignId}, ${person}, 'linkedin', 'active', 1, ${f.account}) returning id`;
    await sql`
      insert into linkedin_enrollment_details (enrollment_id, organization_id, provider_id, profile_url, connection_state)
      values (${id}, ${f.org}, ${member}, ${"https://www.linkedin.com/in/" + slug}, 'connected')`;
    return id;
  }

  /** A person with one active, connected enrollment per campaign, all on the fixture account. */
  async function lead(f: Fixture, name: string, campaignIds: string[]) {
    const slug = `${name.toLowerCase()}-${f.tag}`;
    const member = `ACo-${slug}`;
    const [{ id: person }] = await sql`insert into people (organization_id, linkedin_slug, first_name, full_name) values (${f.org}, ${slug}, ${name}, ${name + " Lovelace"}) returning id`;
    const enrollments: string[] = [];
    for (const c of campaignIds) enrollments.push(await enrollLead(f, person, member, slug, c));
    return { person, member, slug, enrollments };
  }

  const replyPayload = (f: Fixture, member: string, messageId: string, text: string, chat = "chat-" + member, profileUrl?: string) => ({
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
  });
  const receive = (f: Fixture, member: string, messageId: string, text = "Sounds good", chat?: string, profileUrl?: string) =>
    inbound.receiveLinkedInWebhook(deps(), { organizationId: f.org, payload: replyPayload(f, member, messageId, text, chat, profileUrl) });

  const conversationOf = async (f: Fixture) => (await sql`select * from conversations where organization_id = ${f.org} order by created_at`)[0];
  const count = async (table: string, org: string) => Number((await sql.unsafe(`select count(*)::int as n from ${table} where organization_id = $1`, [org]))[0].n);

  beforeAll(async () => {
    inbound = await import("../../application/linkedin-inbound");
    inboundStore = (await import("../drizzle-linkedin-inbound-store")).createDrizzleLinkedInInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
    ({ parseUnipilePayload: parse } = await import("../unipile-webhook"));
    campaignsApp = await import("../../application/linkedin-campaigns");
    linkedinComposition = await import("../linkedin-composition");
    personal = await import("../../application/personal-thread");
    inboxApp = await import("@/contexts/conversations/application/inbox");
    inboxComposition = await import("@/contexts/conversations/infrastructure/composition");
    unread = await import("@/contexts/conversations/infrastructure/drizzle-unread-store");
    crmApp = await import("@/contexts/conversations/application/crm");
    crmComposition = await import("@/contexts/conversations/infrastructure/crm-composition");
    workQueueApp = await import("@/contexts/conversations/actions/application/work-queue");
    workQueueComposition = await import("@/contexts/conversations/actions/infrastructure/work-queue-composition");
    personHandling = (await import("@/contexts/conversations/infrastructure/person-handling")).personReplyHandling;
    dealsApp = await import("@/contexts/deals/application/deals");
    dealsComposition = await import("@/composition/deals");
    aiJobs = await import("@/contexts/conversations/ai/infrastructure/drizzle-ai-job-store");
    replyStore = await import("@/contexts/conversations/infrastructure/drizzle-reply-store");
    linkedinReplyStore = await import("@/contexts/conversations/infrastructure/drizzle-linkedin-reply-store");
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  describe("a reply to a personal campaign", () => {
    it("is stored in a private conversation and stops every active enrollment of the person", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const open = await campaign(f, "regular");
      const ada = await lead(f, "Ada", [quiet, open]);

      expect((await receive(f, ada.member, "m1", "Please call me")).status).toBe("done");

      const conv = await conversationOf(f);
      expect(conv.private_campaign_id).toBe(quiet);
      const [message] = await sql`select * from messages where organization_id = ${f.org}`;
      expect(message).toMatchObject({ direction: "inbound", body_text: "Please call me", conversation_id: conv.id });
      const states = await sql`select campaign_id, status from campaign_enrollments where organization_id = ${f.org}`;
      expect(states.map((r) => r.status)).toEqual(["replied", "replied"]);
    });

    it("leaves the record alone: no state, no version, no inbound pointer, no job, draft, task or stage event", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const ada = await lead(f, "Ada", [quiet]);
      await receive(f, ada.member, "m1", "Please call me");

      const [record] = await sql`select * from records where organization_id = ${f.org}`;
      expect(record).toMatchObject({ workflow_state: "unclassified", context_version: 0, latest_inbound_message_id: null, last_inbound_at: null, active_channel: null });

      await aiJobs.drizzleAiJobStore.enqueueMissing(new Date());
      expect(await count("ai_jobs", f.org)).toBe(0);
      expect(await count("classifications", f.org)).toBe(0);
      expect(await count("drafts", f.org)).toBe(0);
      expect(await count("tasks", f.org)).toBe(0);
      // The safety stop writes its person-level event (no message text). Nothing else is recorded: no stage move, no classification.
      const events = await sql`select event_type from events where organization_id = ${f.org}`;
      expect(events.map((e) => e.event_type)).toEqual(["outreach.stopped_by_reply"]);
    });

    it("stays out of every Inbox view, search, count and the CRM queue", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const ada = await lead(f, "Ada", [quiet]);
      await receive(f, ada.member, "m1", "Please call me about pricing");
      const actor = f.actor("owner");
      const inbox = inboxComposition.inboxDeps();

      for (const view of ["all", "unread", "important", "sent", "replied", "ooo", "automated"] as const) {
        const list = await inboxApp.listInbox(inbox, actor, { view });
        expect(list.total, `view ${view}`).toBe(0);
        expect(list.rows).toEqual([]);
        expect(list.automatedHidden).toBe(0);
      }
      expect((await inboxApp.listInbox(inbox, actor, { query: "pricing" })).total).toBe(0);
      expect((await inboxApp.listInbox(inbox, actor, { leadQuery: "Ada" })).total).toBe(0);
      expect((await inboxApp.listScheduledInbox(inbox, actor, {})).total).toBe(0);
      expect(await unread.drizzleUnreadStore.counts(f.org)).toEqual({ total: 0, linkedin: 0, email: 0 });

      const queue = await workQueueApp.getWorkQueue(workQueueComposition.workQueueDeps(), actor);
      expect(queue.total).toBe(0);
      // The record exists only as the parent of the private thread, so the CRM does not show it at all.
      const [record] = await sql`select id from records where organization_id = ${f.org}`;
      await expect(crmApp.getCrmRecord(crmComposition.crmDeps(), actor, record.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("cannot be opened, marked read, replied to or loaded for the AI by conversation id", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const ada = await lead(f, "Ada", [quiet]);
      await receive(f, ada.member, "m1", "Please call me");
      const { id } = await conversationOf(f);
      const actor = f.actor("owner");
      const inbox = inboxComposition.inboxDeps();

      await expect(inboxApp.getThread(inbox, actor, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(inboxApp.markConversationRead(inbox, actor, id)).rejects.toBeInstanceOf(NotFoundError);
      expect(await replyStore.drizzleReplyStore.panel(f.org, id)).toBeNull();
      expect(await linkedinReplyStore.drizzleLinkedInReplyStore.panel(f.org, id, new Date())).toBeNull();
      await expect(
        linkedinReplyStore.drizzleLinkedInReplyStore.begin({ organizationId: f.org, conversationId: id, text: "hello", idempotencyKey: "k1", actorUserId: f.creator, now: new Date() }),
      ).rejects.toBeInstanceOf(NotFoundError);
      const [message] = await sql`select id, opened_at from messages where conversation_id = ${id}`;
      expect(message.opened_at).toBeNull();
      expect(await aiJobs.drizzleAiJobStore.loadClassifyContext(f.org, message.id)).toBeNull();
      const { buildDraftContext } = await import("@/contexts/conversations/infrastructure/thread-context");
      expect(await buildDraftContext(f.org, id)).toBeNull();
    });

    it("stays private for a replayed delivery and for the next message of the same chat", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const ada = await lead(f, "Ada", [quiet]);
      await receive(f, ada.member, "m1", "First");
      expect((await receive(f, ada.member, "m1", "First")).status).toBe("duplicate");
      await receive(f, ada.member, "m2", "Second");
      expect(await count("messages", f.org)).toBe(2);
      expect(await count("conversations", f.org)).toBe(1);
      expect((await inboxApp.listInbox(inboxComposition.inboxDeps(), f.actor("owner"), {})).total).toBe(0);
    });

    it("turns an older public thread private for good", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const ada = await lead(f, "Ada", []);
      // Ada wrote before she was in any campaign: that thread is public.
      await receive(f, ada.member, "a0", "Hello there", "chat-shared", `https://www.linkedin.com/in/${ada.slug}`);
      const inbox = inboxComposition.inboxDeps();
      expect((await inboxApp.listInbox(inbox, f.actor("owner"), {})).total).toBe(1);

      await enrollLead(f, ada.person, ada.member, ada.slug, quiet);
      await receive(f, ada.member, "a1", "Private please", "chat-shared");
      const [conv] = await sql`select private_campaign_id from conversations where organization_id = ${f.org} and provider_thread_id = 'chat-shared'`;
      expect(conv.private_campaign_id).toBe(quiet);
      expect((await inboxApp.listInbox(inbox, f.actor("owner"), {})).total).toBe(0);
      expect(await unread.drizzleUnreadStore.counts(f.org)).toMatchObject({ total: 0 });
    });
  });

  describe("a reply to a regular campaign", () => {
    it("still reaches the Inbox, the record and the AI queue", async () => {
      const f = await fixture();
      const open = await campaign(f, "regular");
      const ada = await lead(f, "Ada", [open]);
      await receive(f, ada.member, "m1", "Tell me more");

      expect((await conversationOf(f)).private_campaign_id).toBeNull();
      const list = await inboxApp.listInbox(inboxComposition.inboxDeps(), f.actor("owner"), {});
      expect(list.total).toBe(1);
      expect(await unread.drizzleUnreadStore.counts(f.org)).toMatchObject({ total: 1, linkedin: 1 });
      const [record] = await sql`select * from records where organization_id = ${f.org}`;
      expect(record).toMatchObject({ workflow_state: "action_required", context_version: 1 });
      await aiJobs.drizzleAiJobStore.enqueueMissing(new Date());
      expect(await count("ai_jobs", f.org)).toBe(1);
    });

    it("keeps a mixed organization apart: only the regular reply is listed or counted", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const open = await campaign(f, "regular");
      const ada = await lead(f, "Ada", [quiet]);
      const bea = await lead(f, "Bea", [open]);
      await receive(f, ada.member, "a1", "Private");
      await receive(f, bea.member, "b1", "Public");

      const list = await inboxApp.listInbox(inboxComposition.inboxDeps(), f.actor("owner"), {});
      expect(list.rows.map((r) => r.snippet)).toEqual(["Public"]);
      expect(await unread.drizzleUnreadStore.counts(f.org)).toMatchObject({ total: 1 });
      await sql`update campaigns set status = 'active' where organization_id = ${f.org}`;
      const options = await inboxApp.inboxFilterOptions(inboxComposition.inboxDeps(), f.actor("owner"), []);
      expect(options.campaigns.map((c) => c.id)).toEqual([open]);
    });
  });

  it("keeps the upcoming steps of a personal campaign out of the Scheduled view", async () => {
    const f = await fixture();
    const quiet = await campaign(f, "personal");
    const open = await campaign(f, "regular");
    const ada = await lead(f, "Ada", [quiet]);
    const bea = await lead(f, "Bea", [open]);
    await sql`update campaigns set status = 'active' where organization_id = ${f.org}`;
    await sql`update campaign_enrollments set next_send_at = '2026-10-20T10:00:00Z' where organization_id = ${f.org}`;
    const scheduled = await inboxApp.listScheduledInbox(inboxComposition.inboxDeps(), f.actor("owner"), {});
    expect(scheduled.rows.map((r) => r.personId)).toEqual([bea.person]);
    expect(scheduled.rows.map((r) => r.personId)).not.toContain(ada.person);
  });

  it("keeps what a personal campaign sent out of a public thread with the same person", async () => {
    const f = await fixture();
    const quiet = await campaign(f, "personal");
    const open = await campaign(f, "regular");
    const ada = await lead(f, "Ada", [open, quiet]);
    const [regularEnrollment, personalEnrollment] = ada.enrollments;
    await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, body, sent_at, linkedin_account_id)
              values (${f.org}, ${regularEnrollment}, 1, 'linkedin', 'sent', 'Visible note', '2026-10-14T09:00:00Z', ${f.account}),
                     (${f.org}, ${personalEnrollment}, 1, 'linkedin', 'sent', 'Private note', '2026-10-14T09:05:00Z', ${f.account})`;
    // The reply arrives while the person is only known through the regular campaign.
    await sql`delete from linkedin_enrollment_details where enrollment_id = ${personalEnrollment}`;
    await receive(f, ada.member, "m1", "Hi back");
    const { id } = await conversationOf(f);
    const thread = await inboxApp.getThread(inboxComposition.inboxDeps(), f.actor("owner"), id);
    expect(thread.messages.map((m) => m.bodyText)).toEqual(["Visible note", "Hi back"]);
  });

  describe("reading the private thread", () => {
    it("is open to an owner, an admin and the creator, and closed to another member", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const ada = await lead(f, "Ada", [quiet]);
      await receive(f, ada.member, "m1", "Please call me");
      const d = { store: (await import("../drizzle-personal-thread-store")).drizzlePersonalThreadStore };

      for (const actor of [f.actor("owner", "00000000-0000-0000-0000-0000000000aa"), f.actor("admin", "00000000-0000-0000-0000-0000000000ab"), f.actor("member", f.creator)]) {
        const thread = await personal.readPersonalThread(d, actor, quiet, ada.enrollments[0]);
        expect(thread.messages.map((m) => m.text)).toEqual(["Please call me"]);
        expect(thread.personName).toBe("Ada Lovelace");
      }
      await expect(personal.readPersonalThread(d, f.actor("member", "00000000-0000-0000-0000-0000000000ac"), quiet, ada.enrollments[0])).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("does not cross organizations or campaigns", async () => {
      const f = await fixture();
      const other = await fixture();
      const quiet = await campaign(f, "personal");
      const quietToo = await campaign(f, "personal");
      const ada = await lead(f, "Ada", [quiet]);
      await receive(f, ada.member, "m1", "Please call me");
      const d = { store: (await import("../drizzle-personal-thread-store")).drizzlePersonalThreadStore };

      await expect(personal.readPersonalThread(d, other.actor("owner"), quiet, ada.enrollments[0])).rejects.toBeInstanceOf(NotFoundError);
      await expect(personal.readPersonalThread(d, f.actor("owner"), quietToo, ada.enrollments[0])).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("campaign type", () => {
    it("defaults to regular, accepts personal at creation and shows in the list and detail", async () => {
      const f = await fixture();
      const deps = linkedinComposition.linkedinCampaignDeps();
      const { id: plain } = await campaignsApp.createLinkedInCampaign(deps, f.actor("owner"), { name: "Plain" });
      const quiet = await campaign(f, "personal");
      expect((await campaignsApp.getLinkedInCampaign(deps, f.actor("owner"), plain)).type).toBe("regular");
      expect((await campaignsApp.getLinkedInCampaign(deps, f.actor("owner"), quiet)).type).toBe("personal");
      const listed = await campaignsApp.listLinkedInCampaigns(deps, f.actor("owner"));
      expect(Object.fromEntries(listed.map((c) => [c.id, c.type]))).toEqual({ [plain]: "regular", [quiet]: "personal" });
    });

    it("changes before the first send and refuses afterwards", async () => {
      const f = await fixture();
      const deps = linkedinComposition.linkedinCampaignDeps();
      const id = await campaign(f, "regular");
      await campaignsApp.updateLinkedInCampaign(deps, f.actor("owner"), id, { type: "personal" });
      expect((await campaignsApp.getLinkedInCampaign(deps, f.actor("owner"), id)).type).toBe("personal");

      const ada = await lead(f, "Ada", [id]);
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id) values (${f.org}, ${ada.enrollments[0]}, 1, 'linkedin', 'sent', ${f.account})`;
      await expect(campaignsApp.updateLinkedInCampaign(deps, f.actor("owner"), id, { type: "regular" })).rejects.toBeInstanceOf(ConflictError);
      // Saying the type it already has is not a change.
      await expect(campaignsApp.updateLinkedInCampaign(deps, f.actor("owner"), id, { type: "personal", name: "Renamed" })).resolves.toBeUndefined();
    });

    it("lets only LinkedIn campaigns be personal", async () => {
      const f = await fixture();
      await expect(sql`insert into campaigns (organization_id, channel, name, type) values (${f.org}, 'email', 'e', 'personal')`).rejects.toMatchObject({ constraint_name: "campaigns_personal_linkedin_ck" });
      await expect(sql`insert into campaigns (organization_id, channel, name, type) values (${f.org}, 'linkedin', 'e', 'secret')`).rejects.toMatchObject({ constraint_name: "campaigns_type_ck" });
    });

    it("ties a private conversation to a campaign of the same organization", async () => {
      const f = await fixture();
      const other = await fixture();
      const foreign = await campaign(other, "personal");
      const ada = await lead(f, "Ada", []);
      const [{ id: pipeline }] = await sql`insert into pipelines (organization_id, name, is_default) values (${f.org}, 'p', true) returning id`;
      const [{ id: record }] = await sql`insert into records (organization_id, person_id, pipeline_id) values (${f.org}, ${ada.person}, ${pipeline}) returning id`;
      await expect(
        sql`insert into conversations (organization_id, record_id, channel, account_ref, private_campaign_id) values (${f.org}, ${record}, 'linkedin', 'x', ${foreign})`,
      ).rejects.toMatchObject({ constraint_name: "conversations_private_campaign_fk" });
    });
  });

  const crm = () => crmComposition.crmDeps();
  const queueDeps = () => workQueueComposition.workQueueDeps();
  const recordOf = async (personId: string) => (await sql`select * from records where person_id = ${personId}`)[0];

  describe("the CRM does not list a record that exists only for a private thread", () => {
    let f: Fixture;
    let ada: Awaited<ReturnType<typeof lead>>;
    let bea: Awaited<ReturnType<typeof lead>>;
    let cy: Awaited<ReturnType<typeof lead>>;
    let adaRecord: { id: string };
    let visible: string[];
    const actor = () => f.actor("owner");

    beforeAll(async () => {
      f = await fixture();
      const quiet = await campaign(f, "personal");
      const open = await campaign(f, "regular");
      ada = await lead(f, "Ada", [quiet]);
      bea = await lead(f, "Bea", [open]);
      cy = await lead(f, "Cy", []);
      await receive(f, ada.member, "a1", "Private");
      await receive(f, bea.member, "b1", "Public");
      // Cy wrote publicly first (one chat), then joined the personal campaign and answered it in a second chat.
      await receive(f, cy.member, "c0", "Public hello", "chat-cy-public", `https://www.linkedin.com/in/${cy.slug}`);
      await enrollLead(f, cy.person, cy.member, cy.slug, quiet);
      await receive(f, cy.member, "c1", "Private hello", "chat-cy-private");
      adaRecord = { id: (await recordOf(ada.person)).id as string };
      visible = [(await recordOf(bea.person)).id, (await recordOf(cy.person)).id];
    });

    it("still keeps a record for each person", async () => {
      expect((await sql`select count(*)::int as n from records where organization_id = ${f.org}`)[0].n).toBe(3);
    });

    it("keeps it out of the Actions queue, its badge count and the CRM record page", async () => {
      const queue = await workQueueApp.getWorkQueue(queueDeps(), actor());
      const queued = Object.values(queue.groups).flatMap((g) => g.items.map((i) => i.recordId));
      expect(queued).not.toContain(adaRecord.id);
      for (const id of queued) expect(visible).toContain(id);
      expect((await workQueueApp.getWorkQueueCounts(queueDeps(), actor())).total).toBe(queue.total);
      await expect(crmApp.getCrmRecord(crm(), actor(), adaRecord.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("gives no active conversation for a private-only person and the public one for a person with both", async () => {
      expect(await personHandling.activeConversationOfPerson(f.org, ada.person)).toBeNull();
      expect((await personHandling.activeConversationOfPerson(f.org, cy.person))?.conversationId).toBe(
        (await sql`select id from conversations where organization_id = ${f.org} and provider_thread_id = 'chat-cy-public'`)[0].id,
      );
    });

    describe("once each person is a contact with a deal", () => {
      const dealOf = new Map<string, string>();

      beforeAll(async () => {
        // The creator may convert a person of their own personal campaign.
        for (const p of [ada, bea, cy]) dealOf.set(p.person, (await dealsApp.createDealFromLead(dealsComposition.dealsDeps(), actor(), p.person, { title: `Deal ${p.slug}`, ownerId: null })).dealId);
      });

      it("shows every deal on the board without naming the personal campaign", async () => {
        const board = await dealsApp.board(dealsComposition.dealsDeps(), actor());
        const cards = board.columns.flatMap((c) => c.cards);
        expect(cards.map((c) => c.id).sort()).toEqual([...dealOf.values()].sort());
        expect(cards.every((c) => c.source === null || c.source.campaignName !== "personal campaign")).toBe(true);
        expect(JSON.stringify(board)).not.toMatch(/Private|personal campaign/);
      });

      it("lists every contact without naming the personal campaign and dates a private-only person by events no record owns", async () => {
        const contacts = await dealsApp.listContacts(dealsComposition.dealsDeps(), actor(), {});
        expect(contacts.rows.map((r) => r.id).sort()).toEqual([ada.person, bea.person, cy.person].sort());
        expect(JSON.stringify(contacts)).not.toMatch(/Private|personal campaign/);
        const [adaEvents] = await sql`select max(created_at) as at from events where person_id = ${ada.person} and record_id is null`;
        expect(contacts.rows.find((r) => r.id === ada.person)?.lastActivityAt?.getTime()).toBe(new Date(adaEvents.at).getTime());
      });

      it("shows the deal page of a private-only person without a source", async () => {
        const deal = await dealsApp.getDeal(dealsComposition.dealsDeps(), actor(), dealOf.get(ada.person)!);
        expect(deal.source).toBeNull();
        expect(JSON.stringify(deal)).not.toMatch(/Private|personal campaign/);
      });

      it("lists the person events of a private-only person without the private record", async () => {
        const activity = await personHandling.listPersonEvents(f.org, ada.person, 100);
        expect(activity.map((e) => e.eventType).sort()).toEqual(["deal.created", "lifecycle.converted", "outreach.stopped_by_reply"]);
        expect(activity.map((e) => e.recordId)).not.toContain(adaRecord.id);
      });
    });
  });

  describe("a personal campaign is not named outside it", () => {
    async function twoCampaigns() {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const open = await campaign(f, "regular");
      const ada = await lead(f, "Ada", [open, quiet]);
      const [openEnrollment, quietEnrollment] = ada.enrollments;
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, body, sent_at, claimed_at, linkedin_account_id)
                values (${f.org}, ${quietEnrollment}, 1, 'linkedin', 'sent', 'Private note', '2026-10-14T09:00:00Z', '2026-10-14T09:00:00Z', ${f.account}),
                       (${f.org}, ${openEnrollment}, 1, 'linkedin', 'sent', 'Visible note', '2026-10-14T09:05:00Z', '2026-10-14T09:05:00Z', ${f.account})`;
      return { f, quiet, open, ada, openEnrollment, quietEnrollment };
    }

    it("leaves the personal campaign out of the contacted notice and the lead context of a regular campaign, and shows both inside the personal one", async () => {
      const { f, quiet, open, ada } = await twoCampaigns();
      const [third] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${f.org}, 'linkedin', 'Third', 'draft', '[]') returning id`;
      const { drizzleCrossCampaignNotices: notices } = await import("../../../infrastructure/drizzle-cross-campaign-notices");

      const seenFromRegular = await notices.alreadyContacted(f.org, third.id, [ada.person]);
      expect(seenFromRegular.alreadyContacted.map((n) => n.campaign.name)).toEqual(["regular campaign"]);
      expect(seenFromRegular.alreadyContactedPeople).toBe(1);
      const context = (await notices.leadContext(f.org, third.id, [ada.person])).get(ada.person);
      expect(context?.alsoInCampaigns.map((c) => c.campaignId)).toEqual([open]);
      expect(context?.excludedAccounts.map((a) => a.campaignName)).toEqual(["regular campaign"]);

      const seenFromPersonal = (await notices.leadContext(f.org, quiet, [ada.person])).get(ada.person);
      expect(seenFromPersonal?.alsoInCampaigns.map((c) => c.campaignId)).toEqual([open]);
      const insidePersonal = await notices.alreadyContacted(f.org, quiet, [ada.person]);
      expect(insidePersonal.alreadyContacted.map((n) => n.campaign.id)).toEqual([open]);
    });

    it("names no personal campaign in the skipped-by-account notice", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const open = await campaign(f, "regular");
      const ada = await lead(f, "Ada", [quiet, open]);
      const [quietEnrollment, openEnrollment] = ada.enrollments;
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, claimed_at, linkedin_account_id) values (${f.org}, ${quietEnrollment}, 1, 'linkedin', 'sent', now(), ${f.account})`;
      await sql`update campaign_enrollments set status = 'suppressed', stop_reason = 'already_contacted_by_account' where id = ${openEnrollment}`;
      const { drizzleCrossCampaignNotices: notices } = await import("../../../infrastructure/drizzle-cross-campaign-notices");
      const out = await notices.excludedByAccount(f.org, open, null);
      expect(out.excludedByAccount).toHaveLength(1);
      expect(out.excludedByAccount[0].campaign).toBeNull();
    });

    it("hides the personal enrollment and its sends from the lead page", async () => {
      const { f, open, ada } = await twoCampaigns();
      const { drizzleLeadRepository } = await import("@/contexts/leads/infrastructure/drizzle-lead-repository");
      const detail = await drizzleLeadRepository.get(f.org, ada.person);
      expect(detail?.enrollments.map((e) => e.campaignId)).toEqual([open]);
      expect(detail?.sends.map((s) => s.campaignId)).toEqual([open]);
    });

    it("does not count a private reply in a regular campaign's analytics and keeps it in the personal campaign's own numbers", async () => {
      const { f, quiet, open, ada } = await twoCampaigns();
      await receive(f, ada.member, "m1", "Private answer");
      const { drizzleAnalyticsReadModel: analytics } = await import("@/contexts/analytics/infrastructure/drizzle-analytics-read-model");
      const filter = (campaignId: string) => ({ organizationId: f.org, from: "2026-10-14", to: "2026-10-14", timeZone: "UTC", campaignId, excludeArchived: false, linkedinAccountId: null });

      expect((await analytics.linkedin(filter(open))).events.replies).toBe(0);
      expect((await analytics.linkedin(filter(quiet))).events.replies).toBe(1);
      const rows = await analytics.campaigns({ ...filter(open), campaignId: null });
      const byId = new Map(rows.filter((r) => [open, quiet].includes(r.campaignId)).map((r) => [r.campaignId, r]));
      expect(byId.get(open)?.replied).toBe(0);
      expect(byId.get(quiet)?.replied).toBe(1);
    });
  });

  describe("an older public thread that turns private", () => {
    async function flipped(withOtherThread: boolean) {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const ada = await lead(f, "Ada", []);
      const url = `https://www.linkedin.com/in/${ada.slug}`;
      if (withOtherThread) await receive(f, ada.member, "o0", "Hello from another chat", "chat-other", url);
      await receive(f, ada.member, "a0", "Hello there", "chat-shared", url);
      const [shared] = await sql`select id from conversations where organization_id = ${f.org} and provider_thread_id = 'chat-shared'`;
      const [first] = await sql`select id from messages where conversation_id = ${shared.id}`;
      const record = await recordOf(ada.person);
      // Work the public thread produced: a proposed classification, an open draft and a queued classification job.
      await sql`insert into classifications (organization_id, record_id, message_id, expected_context_version, status, confidence, proposed_category_key)
                values (${f.org}, ${record.id}, ${first.id}, ${record.context_version}, 'proposed', 0.9, 'interested')`;
      await sql`insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, status, ai_body_text)
                values (${f.org}, ${record.id}, ${shared.id}, ${record.context_version}, 'linkedin', 'awaiting_review', 'Private-to-be draft')`;
      expect((await recordOf(ada.person)).workflow_state).toBe("action_required");
      await enrollLead(f, ada.person, ada.member, ada.slug, quiet);
      await receive(f, ada.member, "a1", "Private please", "chat-shared");
      return { f, quiet, ada, shared: shared.id as string, first: first.id as string };
    }

    it("resets the shared record, drops the queue item and retires the work of the thread", async () => {
      const { f, ada, shared } = await flipped(false);
      const record = await recordOf(ada.person);
      expect(record.workflow_state).toBe("unclassified");
      expect(record.latest_inbound_message_id).toBeNull();
      expect(record.last_inbound_at).toBeNull();
      expect(record.next_action_at).toBeNull();
      const queue = await workQueueApp.getWorkQueue(queueDeps(), f.actor("owner"));
      expect(queue.total).toBe(0);
      expect((await workQueueApp.getWorkQueueCounts(queueDeps(), f.actor("owner"))).total).toBe(0);
      expect((await sql`select status from drafts where conversation_id = ${shared}`)[0].status).toBe("stale");
      expect((await sql`select status from classifications where record_id = ${record.id}`)[0].status).toBe("stale");
      // Nothing of the thread is left to open: the person has no public conversation, so no screen links to one.
      expect(await personHandling.activeConversationOfPerson(f.org, ada.person)).toBeNull();
    });

    it("falls back to the other public thread of the record and hides drafts and classifications of the private one", async () => {
      const { f, ada, shared, first } = await flipped(true);
      const record = await recordOf(ada.person);
      const [other] = await sql`select m.id from messages m join conversations c on c.id = m.conversation_id where c.provider_thread_id = 'chat-other'`;
      expect(record.latest_inbound_message_id).toBe(other.id);
      expect(record.workflow_state).toBe("action_required");

      // Work for the private thread that lands after the flip (a job that was already running) still stays out of sight.
      const [privateMessage] = await sql`select id from messages where conversation_id = ${shared} order by sent_at desc, created_at desc limit 1`;
      await sql`update records set latest_inbound_message_id = ${privateMessage.id} where id = ${record.id}`;
      await sql`insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, status, ai_body_text)
                values (${f.org}, ${record.id}, ${shared}, ${record.context_version + 1}, 'linkedin', 'awaiting_review', 'Late private draft')`;
      await sql`insert into classifications (organization_id, record_id, message_id, expected_context_version, status, confidence, proposed_category_key)
                values (${f.org}, ${record.id}, ${privateMessage.id}, ${record.context_version + 1}, 'proposed', 0.8, 'interested')`;
      await sql`insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, status, error)
                values (${f.org}, ${record.id}, ${shared}, ${record.context_version + 1}, 'linkedin', 'failed', 'Private failure')`;
      await sql`update records set context_version = context_version + 1 where id = ${record.id}`;

      const detail = await crmApp.getCrmRecord(crm(), f.actor("owner"), record.id);
      expect(detail.conversations.map((c) => c.id)).not.toContain(shared);
      expect(detail.classifications.map((c) => c.messageId)).not.toContain(first);
      expect(detail.classifications.map((c) => c.messageId)).not.toContain(privateMessage.id);
      expect(detail.drafts.map((d) => d.conversationId)).not.toContain(shared);
      const queue = await workQueueApp.getWorkQueue(queueDeps(), f.actor("owner"));
      const items = Object.values(queue.groups).flatMap((g) => g.items).filter((i) => i.recordId === record.id);
      expect(items).toHaveLength(1);
      expect(items[0].draft).toBeNull();
      expect(items[0].classification).toBeNull();
      // The failed draft of the private thread is not a problem for the shared queue.
      expect(items[0].problem).toBeNull();
      expect(items[0].group).not.toBe("problem");
      expect(items[0].conversationId).not.toBe(shared);
      const counts = await workQueueApp.getWorkQueueCounts(queueDeps(), f.actor("owner"));
      expect(counts.byGroup.reply).toBe(0);
      expect(counts.byGroup.classification).toBe(0);
    });
  });

  describe("a personal lead is recognized before the profile resolved", () => {
    async function leadWithoutMember(over: { slug?: boolean; rawMember?: boolean; otherAccount?: boolean }) {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const tag = uniqueKey();
      const slug = `early-${tag}`;
      const member = `ACo-early-${tag}`;
      const [{ id: person }] = await sql`
        insert into people (organization_id, linkedin_slug, first_name, full_name, raw)
        values (${f.org}, ${over.slug === false ? null : slug}, 'Early', 'Early Bird', ${sql.json(over.rawMember ? { linkedin_member_id: member } : {})}) returning id`;
      let account: string | null = null;
      if (over.otherAccount) {
        [{ id: account }] = await sql`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status) values (${f.org}, ${"acct2-" + f.tag}, ${"ACo-2-" + f.tag}, ${"owner2-" + f.tag}, 'connected') returning id`;
      }
      const [{ id: enrollment }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, linkedin_account_id)
        values (${f.org}, ${quiet}, ${person}, 'linkedin', 'pending', 0, ${account}) returning id`;
      await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, profile_url, connection_state) values (${enrollment}, ${f.org}, ${"https://www.linkedin.com/in/" + slug}, 'none')`;
      return { f, quiet, person, slug, member, enrollment };
    }

    it("matches the person by profile slug when the enrollment has no member id and no account yet", async () => {
      const { f, quiet, member, slug, enrollment } = await leadWithoutMember({});
      await receive(f, member, "e1", "Hi, saw your note", "chat-early", `https://www.linkedin.com/in/${slug}`);
      expect((await conversationOf(f)).private_campaign_id).toBe(quiet);
      expect((await sql`select status from campaign_enrollments where id = ${enrollment}`)[0].status).toBe("replied");
      expect((await inboxApp.listInbox(inboxComposition.inboxDeps(), f.actor("owner"), {})).total).toBe(0);
    });

    it("matches the person by stored member id when the reply carries no profile address", async () => {
      const { f, quiet, member } = await leadWithoutMember({ slug: false, rawMember: true });
      await receive(f, member, "e2", "Hi", "chat-early-2");
      expect((await conversationOf(f)).private_campaign_id).toBe(quiet);
    });

    it("matches a lead whose enrollment sits on another account of the organization", async () => {
      const { f, quiet, member, slug } = await leadWithoutMember({ otherAccount: true });
      await receive(f, member, "e3", "Hi", "chat-early-3", `https://www.linkedin.com/in/${slug}`);
      expect((await conversationOf(f)).private_campaign_id).toBe(quiet);
    });

    it("matches a lead whose member id was resolved through another account, when the reply carries no profile address", async () => {
      const { f, quiet, member, enrollment } = await leadWithoutMember({ slug: false, otherAccount: true });
      await sql`update linkedin_enrollment_details set provider_id = ${member} where enrollment_id = ${enrollment}`;
      await receive(f, member, "e5", "Hi", "chat-early-5");
      expect((await conversationOf(f)).private_campaign_id).toBe(quiet);
    });

    it("leaves a stranger public", async () => {
      const { f } = await leadWithoutMember({});
      await receive(f, "ACo-stranger", "e4", "Who are you", "chat-stranger", "https://www.linkedin.com/in/someone-else");
      expect((await conversationOf(f)).private_campaign_id).toBeNull();
    });
  });

  describe("campaign type changes", () => {
    const deps = () => linkedinComposition.linkedinCampaignDeps();

    it("refuses a type change when a send commits while the change waits for the campaign row", async () => {
      const f = await fixture();
      const id = await campaign(f, "regular");
      const ada = await lead(f, "Ada", [id]);
      let held!: () => void;
      const gate = new Promise<void>((resolve) => (held = resolve));
      let claimed!: () => void;
      const claimStarted = new Promise<void>((resolve) => (claimed = resolve));
      // A claim in flight: it shares the campaign row, inserts its send and has not committed yet.
      const claim = sql.begin(async (tx) => {
        await tx`select id from campaigns where id = ${id} for share`;
        await tx`insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id) values (${f.org}, ${ada.enrollments[0]}, 1, 'linkedin', 'sending', ${f.account})`;
        claimed();
        await gate;
      });
      await claimStarted;
      let settled = false;
      const change = campaignsApp.updateLinkedInCampaign(deps(), f.actor("owner"), id, { type: "personal" }).then(
        () => ((settled = true), "changed" as const),
        (error: unknown) => ((settled = true), error),
      );
      await waitForLockWaiters(sql, 1);
      expect(settled, "the change must wait for the claim").toBe(false);
      held();
      await claim;
      expect(await change).toBeInstanceOf(ConflictError);
      expect((await campaignsApp.getLinkedInCampaign(deps(), f.actor("owner"), id)).type).toBe("regular");
    });

    it("makes the engine claim wait for a type change that holds the campaign row, and lets it send afterwards", async () => {
      const f = await fixture();
      const id = await campaign(f, "regular");
      const steps = [
        { stepNumber: 1, kind: "invitation", body: "Hi", waitDays: 0 },
        { stepNumber: 2, kind: "message", body: "Thanks", waitDays: 0 },
      ];
      await sql`update campaigns set status = 'active', steps = ${sql.json(steps as never)} where id = ${id}`;
      const ada = await lead(f, "Ada", [id]);
      await sql`update campaign_enrollments set next_send_at = '2026-10-14T11:00:00Z' where id = ${ada.enrollments[0]}`;
      const { drizzleLinkedInStore } = await import("../drizzle-linkedin-store");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const rowLocked = new Promise<void>((resolve) => (locked = resolve));
      // A type change in flight: it holds the campaign row and has not committed yet.
      const change = sql.begin(async (tx) => {
        await tx`select id from campaigns where id = ${id} for update`;
        locked();
        await gate;
      });
      await rowLocked;
      let settled = false;
      const claim = drizzleLinkedInStore
        .claimNext({ accountId: f.account, now: clock.now(), random: () => 0, defaultWorkingHours: (): WorkingHours => ({ timeZone: "UTC", days: ALL_DAY }) as WorkingHours })
        .finally(() => (settled = true));
      await waitForLockWaiters(sql, 1);
      const [waiting] = await sql`select query from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
      expect(waiting.query).toMatch(/from campaigns where id = .* for share/);
      expect(settled, "the claim must wait for the type change").toBe(false);
      release();
      await change;
      expect(await claim).toMatchObject({ kind: "message", stepNumber: 2 });
      expect((await sql`select status from sends where enrollment_id = ${ada.enrollments[0]}`).map((r) => r.status)).toEqual(["sending"]);
    });

    it("refuses to change away from personal once private replies exist", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const ada = await lead(f, "Ada", [quiet]);
      await receive(f, ada.member, "m1", "Please call");
      await expect(campaignsApp.updateLinkedInCampaign(deps(), f.actor("owner"), quiet, { type: "regular" })).rejects.toThrow(/private replies/);
      expect((await campaignsApp.getLinkedInCampaign(deps(), f.actor("owner"), quiet)).type).toBe("personal");
    });

    it("answers 409 when deleting a campaign that holds private conversations", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const ada = await lead(f, "Ada", [quiet]);
      await receive(f, ada.member, "m1", "Please call");
      await expect(campaignsApp.deleteLinkedInCampaign(deps(), f.actor("owner"), quiet)).rejects.toBeInstanceOf(ConflictError);
      expect((await sql`select count(*)::int as n from campaigns where id = ${quiet}`)[0].n).toBe(1);
    });
  });

  describe("private conversations seen from outside the thread", () => {
    it("answers not found when starring a message of a private conversation, and still stars a public one", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const open = await campaign(f, "regular");
      const ada = await lead(f, "Ada", [quiet]);
      const bea = await lead(f, "Bea", [open]);
      await receive(f, ada.member, "a1", "Private");
      await receive(f, bea.member, "b1", "Public");
      const tasks = await import("@/contexts/conversations/actions/infrastructure/drizzle-task-store");
      const [privateMessage] = await sql`select id from messages where organization_id = ${f.org} and body_text = 'Private'`;
      const [publicMessage] = await sql`select id from messages where organization_id = ${f.org} and body_text = 'Public'`;
      expect(await tasks.drizzleTaskStore.setMessageImportant(f.org, privateMessage.id, true)).toBe(false);
      expect((await sql`select important from messages where id = ${privateMessage.id}`)[0].important).toBe(false);
      expect(await tasks.drizzleTaskStore.setMessageImportant(f.org, publicMessage.id, true)).toBe(true);
    });

    it("marks a lead with a private conversation whatever the enrollment status is", async () => {
      const f = await fixture();
      const quiet = await campaign(f, "personal");
      const ada = await lead(f, "Ada", [quiet]);
      const bea = await lead(f, "Bea", [quiet]);
      await receive(f, ada.member, "m1", "Please call");
      await sql`update campaign_enrollments set status = 'removed' where id = ${ada.enrollments[0]}`;
      const { drizzleLinkedInCampaignStore } = await import("../drizzle-linkedin-campaign-store");
      const marks = async (tab: "removed" | "all") =>
        (await drizzleLinkedInCampaignStore.listEnrollments(f.org, quiet, { tab, search: "", page: 1, pageSize: 25 })).rows.map((r) => [r.enrollmentId, r.hasPrivateThread]);
      expect(await marks("removed")).toEqual([[ada.enrollments[0], true]]);
      // The all tab leaves removed leads out.
      expect(await marks("all")).toEqual([[bea.enrollments[0], false]]);
    });
  });
});
