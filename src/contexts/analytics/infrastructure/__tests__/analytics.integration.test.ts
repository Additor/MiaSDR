import { afterAll, beforeAll, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { ValidationError } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */
describeDb("analytics read model", () => {
  useTestEnv();
  const sql = testSql({ max: 3 });
  let uc: typeof import("../../application/analytics-queries");
  let exportUc: typeof import("../../application/export");
  let deps: import("../../application/analytics-queries").AnalyticsDeps;
  const orgs: string[] = [];
  const users: string[] = [];
  const tag = Math.random().toString(36).slice(2, 8);
  let n = 0;
  const uniq = () => `${tag}${n++}`;

  // New York is UTC-4 from 2026-03-08. The window is the three local days 03-10 to 03-12.
  const WINDOW = { from: "2026-03-10", to: "2026-03-12" };
  const NY = "America/New_York";

  interface World {
    actor: Actor;
    emailCampaign: string;
    linkedinCampaign: string;
    mailbox: string;
    account: string;
  }

  async function seed(opts: { full: boolean }): Promise<World> {
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('A', ${"an-" + uniq()}) returning id`;
    orgs.push(org);
    const [{ id: user }] = await sql`insert into users (name, email) values ('U', ${uniq() + "@an.test"}) returning id`;
    users.push(user);
    await sql`insert into channel_settings (organization_id, channel, values) values (${org}, 'general', ${sql.json({ timeZone: NY })})`;
    const [{ id: mailbox }] = await sql`insert into mailboxes (organization_id, email_address, status) values (${org}, ${uniq() + "@sender.test"}, 'connected') returning id`;
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, name, status) values (${org}, ${"p" + uniq()}, ${"l" + uniq()}, 'Sales Rep', 'connected') returning id`;
    const liSteps = [
      { stepNumber: 1, kind: "invitation", body: "hi", waitDays: 0 },
      { stepNumber: 2, kind: "message", body: "thanks", waitDays: 2 },
    ];
    const [{ id: emailCampaign }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${org}, 'email', 'Email launch', 'active') returning id`;
    const [{ id: linkedinCampaign }] = await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${org}, 'linkedin', 'LI outreach', 'active', ${sql.json(liSteps)}) returning id`;
    const world: World = { actor: { userId: user, organizationId: org, role: "member" }, emailCampaign, linkedinCampaign, mailbox, account };
    if (!opts.full) {
      // A different organization with one confirmed send inside the window.
      const p = await person(org);
      const e = await enroll(org, emailCampaign, p, "email", "active", { mailbox });
      await send(org, e, 1, "email", "sent", "2026-03-11T15:00:00Z", { mailbox });
      return world;
    }

    const pipeline = (await sql`insert into pipelines (organization_id, name, is_default) values (${org}, 'default', true) returning id`)[0].id as string;
    const subInterested = (await sql`insert into subcategories (organization_id, pipeline_id, category_key, key, name) values (${org}, ${pipeline}, 'interested', 'meeting', 'Meeting requested') returning id`)[0].id as string;
    const subNo = (await sql`insert into subcategories (organization_id, pipeline_id, category_key, key, name) values (${org}, ${pipeline}, 'not_interested', 'no_budget', 'No budget') returning id`)[0].id as string;

    const reply = async (personId: string, channel: "email" | "linkedin", at: string, classification?: { status: string; category?: string; sub?: string }) => {
      const ref = channel === "email" ? "a@sender.test" : account;
      const [{ id: record }] = await sql`insert into records (organization_id, person_id, pipeline_id) values (${org}, ${personId}, ${pipeline}) on conflict (person_id, pipeline_id) do update set updated_at = now() returning id`;
      const [conv] = await sql`select id from conversations where record_id = ${record} and channel = ${channel}`;
      const conversation = conv?.id ?? (await sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${org}, ${record}, ${channel}, ${ref}) returning id`)[0].id;
      const [{ id: message }] = await sql`
        insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
        values (${org}, ${conversation}, ${channel}, ${ref}, 'inbound', ${uniq()}, 'reply', ${at}) returning id`;
      if (classification) {
        await sql`
          insert into classifications (organization_id, record_id, message_id, expected_context_version, status, confidence, proposed_category_key, applied_category_key, applied_subcategory_id)
          values (${org}, ${record}, ${message}, 0, ${classification.status}, 0.9, ${classification.category ?? null}, ${classification.status === "proposed" ? null : (classification.category ?? null)}, ${classification.sub ?? null})`;
      }
    };

    // Email campaign. Times are UTC; the comment gives the New York day.
    const p1 = await person(org);
    const e1 = await enroll(org, emailCampaign, p1, "email", "replied", { mailbox });
    await send(org, e1, 1, "email", "sent", "2026-03-10T03:30:00Z", { mailbox }); // 03-09 local, UTC day would say 03-10
    const p2 = await person(org);
    const e2 = await enroll(org, emailCampaign, p2, "email", "replied", { mailbox });
    await send(org, e2, 1, "email", "sent", "2026-03-10T15:00:00Z", { mailbox }); // 03-10
    const p3 = await person(org);
    const e3 = await enroll(org, emailCampaign, p3, "email", "bounced", { mailbox });
    await send(org, e3, 1, "email", "sent", "2026-03-11T16:00:00Z", { mailbox }); // 03-11
    await send(org, e3, 2, "email", "unknown", null, { mailbox, claimedAt: "2026-03-12T16:00:00Z" }); // 03-12
    const p4 = await person(org);
    const e4 = await enroll(org, emailCampaign, p4, "email", "active", { mailbox });
    await send(org, e4, 1, "email", "unknown", null, { mailbox, claimedAt: "2026-03-11T10:00:00Z" }); // 03-11, never confirmed
    const p5 = await person(org);
    const e5 = await enroll(org, emailCampaign, p5, "email", "replied", { mailbox });
    await send(org, e5, 1, "email", "sent", "2026-03-12T02:00:00Z", { mailbox }); // 03-11 local, UTC day would say 03-12
    const p6 = await person(org);
    const e6 = await enroll(org, emailCampaign, p6, "email", "active", { mailbox });
    await send(org, e6, 1, "email", "sent", "2026-03-13T05:00:00Z", { mailbox }); // 03-13 local, after the window
    const p7 = await person(org);
    const e7 = await enroll(org, emailCampaign, p7, "email", "failed", { mailbox });
    await send(org, e7, 1, "email", "failed", null, { mailbox, claimedAt: "2026-03-11T12:00:00Z" });
    const p8 = await person(org);
    const e8 = await enroll(org, emailCampaign, p8, "email", "active", { mailbox });
    await send(org, e8, 1, "email", "sending", null, { mailbox, claimedAt: "2026-03-12T09:00:00Z" });

    await reply(p1, "email", "2026-03-11T12:00:00Z"); // contacted before the window, so a reply but not a cohort reply
    await reply(p2, "email", "2026-03-11T14:00:00Z", { status: "auto_applied", category: "interested", sub: subInterested });
    await reply(p5, "email", "2026-03-12T20:00:00Z", { status: "proposed", category: "interested" });
    await reply(await person(org), "email", "2026-03-11T14:00:00Z"); // never contacted: not attributed to any campaign

    // LinkedIn campaign.
    const l1p = await person(org);
    const l1 = await enroll(org, linkedinCampaign, l1p, "linkedin", "replied", { account });
    await send(org, l1, 1, "linkedin", "sent", "2026-03-10T14:00:00Z", { account });
    await send(org, l1, 2, "linkedin", "sent", "2026-03-11T15:00:00Z", { account });
    await details(org, l1, "connected", "2026-03-11T10:00:00Z");
    await reply(l1p, "linkedin", "2026-03-12T12:00:00Z", { status: "overridden", category: "not_interested", sub: subNo });
    const l2 = await enroll(org, linkedinCampaign, await person(org), "linkedin", "active", { account });
    await send(org, l2, 1, "linkedin", "sent", "2026-03-11T14:00:00Z", { account });
    await details(org, l2, "request_sent", null);
    const l3 = await enroll(org, linkedinCampaign, await person(org), "linkedin", "active", { account });
    await send(org, l3, 1, "linkedin", "unknown", null, { account, claimedAt: "2026-03-11T09:00:00Z" });
    await details(org, l3, "none", null);
    const l4 = await enroll(org, linkedinCampaign, await person(org), "linkedin", "active", { account });
    await send(org, l4, 1, "linkedin", "sent", "2026-03-05T14:00:00Z", { account });
    await details(org, l4, "connected", "2026-03-11T08:00:00Z");

    await sql`insert into suppression_list (organization_id, email, reason, created_at) values (${org}, ${uniq() + "@b.test"}, 'bounced', '2026-03-11T12:00:00Z')`;
    await sql`insert into suppression_list (organization_id, email, reason, created_at) values (${org}, ${uniq() + "@u.test"}, 'unsubscribed', '2026-02-01T12:00:00Z')`;
    return world;
  }

  async function person(org: string): Promise<string> {
    return (await sql`insert into people (organization_id, email) values (${org}, ${uniq() + "@lead.test"}) returning id`)[0].id as string;
  }
  async function enroll(org: string, campaign: string, personId: string, channel: string, status: string, who: { mailbox?: string; account?: string }): Promise<string> {
    return (
      await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, mailbox_id, linkedin_account_id)
        values (${org}, ${campaign}, ${personId}, ${channel}, ${status}, ${who.mailbox ?? null}, ${who.account ?? null}) returning id`
    )[0].id as string;
  }
  async function send(org: string, enrollment: string, step: number, channel: string, status: string, sentAt: string | null, opts: { mailbox?: string; account?: string; claimedAt?: string }) {
    await sql`
      insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id, linkedin_account_id, claimed_at, sent_at)
      values (${org}, ${enrollment}, ${step}, ${channel}, ${status}, ${opts.mailbox ?? null}, ${opts.account ?? null}, ${opts.claimedAt ?? sentAt}, ${sentAt})`;
  }
  async function details(org: string, enrollment: string, state: string, acceptedAt: string | null) {
    await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, connection_state, accepted_at) values (${enrollment}, ${org}, ${state}, ${acceptedAt})`;
  }

  /**
   * Gives `rival` one contacted email lead and one LinkedIn lead, each with a reply, plus an accepted invitation and a
   * complaint suppression, all inside the window. A view that drops an organization filter counts these for `world`.
   */
  async function rivalActivity(w: World) {
    const org = w.actor.organizationId;
    const [{ id: pipeline }] = await sql`insert into pipelines (organization_id, name, is_default) values (${org}, 'default', true) returning id`;
    const reply = async (personId: string, channel: "email" | "linkedin", at: string) => {
      const ref = channel === "email" ? "a@sender.test" : w.account;
      const [{ id: record }] = await sql`insert into records (organization_id, person_id, pipeline_id) values (${org}, ${personId}, ${pipeline}) returning id`;
      const [{ id: conversation }] = await sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${org}, ${record}, ${channel}, ${ref}) returning id`;
      await sql`
        insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
        values (${org}, ${conversation}, ${channel}, ${ref}, 'inbound', ${uniq()}, 'reply', ${at})`;
    };
    const [{ person_id: emailLead }] = await sql`select person_id from campaign_enrollments where organization_id = ${org}`;
    await reply(emailLead, "email", "2026-03-12T15:00:00Z"); // 03-12
    const liLead = await person(org);
    const li = await enroll(org, w.linkedinCampaign, liLead, "linkedin", "replied", { account: w.account });
    await send(org, li, 1, "linkedin", "sent", "2026-03-10T16:00:00Z", { account: w.account }); // 03-10
    await send(org, li, 2, "linkedin", "sent", "2026-03-11T16:00:00Z", { account: w.account }); // 03-11
    await details(org, li, "connected", "2026-03-11T11:00:00Z"); // 03-11
    await reply(liLead, "linkedin", "2026-03-12T13:00:00Z"); // 03-12
    await sql`insert into suppression_list (organization_id, email, reason, created_at) values (${org}, ${uniq() + "@c.test"}, 'complaint', '2026-03-11T12:00:00Z')`;
  }

  let world: World;
  let other: World;
  let rival: World;

  beforeAll(async () => {
    uc = await import("../../application/analytics-queries");
    exportUc = await import("../../application/export");
    const { drizzleAnalyticsReadModel } = await import("../drizzle-analytics-read-model");
    deps = { readModel: drizzleAnalyticsReadModel, now: () => new Date("2026-03-12T20:00:00Z") };
    world = await seed({ full: true });
    other = await seed({ full: false });
    rival = await seed({ full: false });
    await rivalActivity(rival);
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  const get = <V extends import("../../application/analytics-queries").AnalyticsView>(view: V, extra: Record<string, string | boolean | undefined> = {}, actor = world.actor) =>
    uc.getAnalytics(deps, actor, view, { ...WINDOW, ...extra }) as Promise<Extract<Awaited<ReturnType<typeof uc.getAnalytics>>, { view: V }>>;

  it("reports campaign performance with cohort rates and unknown sends apart from sent", async () => {
    const { data, scope } = await get("campaigns");
    expect(scope.timeZone).toBe(NY);
    const email = data.rows.find((r) => r.campaignId === world.emailCampaign)!;
    expect(email).toMatchObject({ enrolled: 8, contacted: 3, replied: 2, bounced: 1 });
    expect(email.replyRate).toBeCloseTo(2 / 3);
    expect(email.bounceRate).toBeCloseTo(1 / 3);
    // Sent: e2, e3, e5 in the window. e1 (03-09 local) and e6 (03-13 local) fall outside.
    expect(email.sends).toEqual({ sent: 3, unknown: 2, failed: 1, inFlight: 1 });
    const li = data.rows.find((r) => r.campaignId === world.linkedinCampaign)!;
    expect(li).toMatchObject({ enrolled: 4, contacted: 2, replied: 1 });
    expect(li.sends.unknown).toBe(1);
    expect(data.totals.sends.sent).toBe(3 + 3);
  });

  it("does not count auto-replies or unverified bounce notices as replies", async () => {
    const org = other.actor.organizationId;
    const [enrollment] = await sql`select e.person_id from campaign_enrollments e where e.organization_id = ${org} limit 1`;
    const [{ id: pipeline }] = await sql`insert into pipelines (organization_id, name, is_default) values (${org}, 'default', true) returning id`;
    const [{ id: record }] = await sql`insert into records (organization_id, person_id, pipeline_id) values (${org}, ${enrollment.person_id}, ${pipeline}) returning id`;
    const [{ id: conversation }] = await sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${org}, ${record}, 'email', 'a@sender.test') returning id`;
    await sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at, raw)
      values (${org}, ${conversation}, 'email', 'a@sender.test', 'inbound', ${uniq()}, 'I am away', '2026-03-11T19:00:00Z', ${sql.json({ autoReply: true })})`;
    const { data } = await get("campaigns", {}, other.actor);
    expect(data.totals.contacted).toBe(1);
    expect(data.totals.replied).toBe(0);
    const replies = await get("replies", {}, other.actor);
    expect(JSON.stringify(replies.data)).not.toContain("I am away");
  });

  it("counts an archived campaign unless the filter excludes it", async () => {
    await sql`update campaigns set archived_at = now() where id = ${world.linkedinCampaign}`;
    try {
      const all = await get("campaigns");
      expect(all.data.rows.map((r) => r.campaignId)).toContain(world.linkedinCampaign);
      expect(all.data.totals.sends.sent).toBe(3 + 3);
      expect(all.scope.excludeArchived).toBe(false);

      const hidden = await get("campaigns", { excludeArchived: true });
      expect(hidden.data.rows.map((r) => r.campaignId)).toEqual([world.emailCampaign]);
      expect(hidden.data.totals.sends.sent).toBe(3);
      // The exclusion reaches the other views too: LinkedIn funnel and channel totals.
      expect((await get("linkedin", { excludeArchived: true })).data.campaigns).toHaveLength(0);
      expect((await get("linkedin")).data.campaigns).toHaveLength(1);

      const options = await uc.getFilterOptions(deps, world.actor);
      expect(options.campaigns.find((c) => c.id === world.linkedinCampaign)?.archived).toBe(true);
    } finally {
      await sql`update campaigns set archived_at = null where id = ${world.linkedinCampaign}`;
    }
  });

  it("filters by campaign", async () => {
    const { data } = await get("campaigns", { campaignId: world.linkedinCampaign });
    expect(data.rows.map((r) => r.campaignId)).toEqual([world.linkedinCampaign]);
    expect(data.totals.contacted).toBe(2);
  });

  it("breaks sends down by channel and sender", async () => {
    const { data } = await get("channels");
    const email = data.channels.find((c) => c.channel === "email")!;
    expect(email).toMatchObject({ contacted: 3, replied: 2, bounced: 1 });
    expect(email.sends).toEqual({ sent: 3, unknown: 2, failed: 1, inFlight: 1 });
    const mailbox = data.senders.find((s) => s.channel === "email")!;
    expect(mailbox).toMatchObject({ senderId: world.mailbox, contacted: 3, status: "connected" });
    expect(mailbox.sends.unknown).toBe(2);
    const account = data.senders.find((s) => s.channel === "linkedin")!;
    expect(account).toMatchObject({ senderId: world.account, label: "Sales Rep", contacted: 2 });
    const scoped = await get("channels", { campaignId: world.emailCampaign });
    expect(scoped.data.channels.find((c) => c.channel === "linkedin")!.sends).toEqual({ sent: 0, unknown: 0, failed: 0, inFlight: 0 });
  });

  it("builds the LinkedIn funnel from people invited in the window", async () => {
    const { data } = await get("linkedin");
    expect(data.funnel).toMatchObject({ invited: 2, accepted: 1, messaged: 1, replied: 1, acceptanceRate: 0.5, messageRate: 1, replyRate: 1 });
    expect(data.events.invites).toEqual({ sent: 2, unknown: 1, failed: 0, inFlight: 0 });
    expect(data.events.messages.sent).toBe(1);
    expect(data.events.accepted).toBe(2); // l1 and l4, whenever they were invited
    expect(data.events.replies).toBe(1);
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]).toMatchObject({ name: "Sales Rep", accepted: 2 });
    expect(data.accounts[0].invites.unknown).toBe(1);
    const none = await get("linkedin", { linkedinAccountId: "00000000-0000-4000-8000-000000000000" });
    expect(none.data.funnel.invited).toBe(0);
    expect(none.data.funnel.acceptanceRate).toBeNull();
  });

  it("classifies replies and hides suppressions behind a campaign filter", async () => {
    const { data } = await get("replies");
    expect(data.total).toBe(4);
    const counts = Object.fromEntries(data.byBucket.map((b) => [b.bucket, b.replies]));
    expect(counts).toEqual({ customer: 0, interested: 1, not_interested: 1, other: 0, pending_review: 1, unclassified: 1 });
    expect(data.classifiedShare).toBe(0.5);
    expect(data.bySubcategory).toEqual([
      { bucket: "interested", name: "Meeting requested", replies: 1 },
      { bucket: "not_interested", name: "No budget", replies: 1 },
    ]);
    expect(data.byChannel.find((c) => c.channel === "linkedin")!.total).toBe(1);
    expect(data.suppressions).toEqual({ unsubscribed: 0, bounced: 1, manual: 0, complaint: 0 });
    const scoped = await get("replies", { campaignId: world.emailCampaign });
    expect(scoped.data.total).toBe(3);
    expect(scoped.data.suppressions).toBeNull();
  });

  it("buckets the time series by the organization's local day", async () => {
    const { data } = await get("timeseries");
    const by = (day: string) => data.points.find((p) => p.day === day)!;
    expect(data.points.map((p) => p.day)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
    expect([by("2026-03-10").email_sent, by("2026-03-11").email_sent, by("2026-03-12").email_sent]).toEqual([1, 2, 0]);
    expect([by("2026-03-10").email_unknown, by("2026-03-11").email_unknown, by("2026-03-12").email_unknown]).toEqual([0, 1, 1]);
    expect(data.totals.email_failed).toBe(1);
    expect([by("2026-03-11").replies_email, by("2026-03-12").replies_email, by("2026-03-12").replies_linkedin]).toEqual([2, 1, 1]);
    expect(by("2026-03-10").linkedin_invites).toBe(1);
    expect(by("2026-03-11")).toMatchObject({ linkedin_invites: 1, linkedin_messages: 1, linkedin_accepted: 2, linkedin_unknown: 1 });
  });

  it("defaults to the last 30 local days and rejects bad input", async () => {
    const { scope } = await uc.getAnalytics(deps, world.actor, "campaigns", {});
    expect(scope.range).toEqual({ from: "2026-02-11", to: "2026-03-12" });
    await expect(uc.getAnalytics(deps, world.actor, "campaigns", { from: "2026-03-12", to: "2026-03-01" })).rejects.toBeInstanceOf(ValidationError);
    await expect(uc.getAnalytics(deps, world.actor, "campaigns", { ...WINDOW, campaignId: "not-a-uuid" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("never leaks another organization's rows", async () => {
    const { data } = await get("campaigns", {}, other.actor);
    expect(data.rows.map((r) => r.campaignId).sort()).toEqual([other.emailCampaign, other.linkedinCampaign].sort());
    expect(data.totals.sends).toEqual({ sent: 1, unknown: 0, failed: 0, inFlight: 0 });
    const own = await get("campaigns", { campaignId: other.emailCampaign });
    expect(own.data.rows).toEqual([]);
  });

  it("counts only the caller's organization in every view", async () => {
    // `world` has more of everything in the window, so a missing organization filter inflates each count below.
    // The tests above assert `world`'s own counts with `rival`'s rows present.
    const none = { sent: 0, unknown: 0, failed: 0, inFlight: 0 };
    const campaigns = (await get("campaigns", {}, rival.actor)).data;
    expect(campaigns.rows.find((r) => r.campaignId === rival.emailCampaign)).toMatchObject({ enrolled: 1, contacted: 1, replied: 1, bounced: 0, sends: { ...none, sent: 1 } });
    expect(campaigns.rows.find((r) => r.campaignId === rival.linkedinCampaign)).toMatchObject({ enrolled: 1, contacted: 1, replied: 1, bounced: 0, sends: { ...none, sent: 2 } });

    const channels = (await get("channels", {}, rival.actor)).data;
    expect(channels.channels.find((c) => c.channel === "email")).toMatchObject({ contacted: 1, replied: 1, bounced: 0, sends: { ...none, sent: 1 } });
    expect(channels.channels.find((c) => c.channel === "linkedin")).toMatchObject({ contacted: 1, replied: 1, bounced: 0, sends: { ...none, sent: 2 } });
    expect(channels.senders.map((s) => [s.senderId, s.contacted, s.sends.sent])).toEqual([
      [rival.mailbox, 1, 1],
      [rival.account, 1, 2],
    ]);

    const linkedin = (await get("linkedin", {}, rival.actor)).data;
    expect(linkedin.funnel).toMatchObject({ invited: 1, accepted: 1, messaged: 1, replied: 1 });
    expect(linkedin.events).toEqual({ invites: { ...none, sent: 1 }, messages: { ...none, sent: 1 }, accepted: 1, replies: 1 });
    expect(linkedin.accounts).toHaveLength(1);
    expect(linkedin.accounts[0]).toMatchObject({ accountId: rival.account, accepted: 1, invites: { ...none, sent: 1 }, messages: { ...none, sent: 1 } });

    const replies = (await get("replies", {}, rival.actor)).data;
    expect(replies.total).toBe(2);
    expect(Object.fromEntries(replies.byBucket.map((b) => [b.bucket, b.replies]))).toEqual({ customer: 0, interested: 0, not_interested: 0, other: 0, pending_review: 0, unclassified: 2 });
    expect(replies.suppressions).toEqual({ unsubscribed: 0, bounced: 0, manual: 0, complaint: 1 });

    const series = (await get("timeseries", {}, rival.actor)).data;
    const by = (day: string) => series.points.find((p) => p.day === day)!;
    expect(by("2026-03-10")).toMatchObject({ email_sent: 0, linkedin_invites: 1, linkedin_messages: 0, linkedin_accepted: 0, replies_email: 0, replies_linkedin: 0 });
    expect(by("2026-03-11")).toMatchObject({ email_sent: 1, linkedin_invites: 0, linkedin_messages: 1, linkedin_accepted: 1, replies_email: 0, replies_linkedin: 0 });
    expect(by("2026-03-12")).toMatchObject({ email_sent: 0, linkedin_invites: 0, linkedin_messages: 0, linkedin_accepted: 0, replies_email: 1, replies_linkedin: 1 });
  });

  it("exports each view as CSV", async () => {
    const { filename, csv } = exportUc.reportCsv(await get("campaigns"));
    expect(filename).toBe("analytics-campaigns-2026-03-10-to-2026-03-12.csv");
    expect(csv.split("\r\n")[0]).toContain("Unknown outcome");
    expect(csv).toContain("Email launch,email,active,8,3,2,1");
    for (const view of ["channels", "linkedin", "replies", "timeseries"] as const) {
      expect(exportUc.reportCsv(await get(view)).csv.length).toBeGreaterThan(20);
    }
  });
});
