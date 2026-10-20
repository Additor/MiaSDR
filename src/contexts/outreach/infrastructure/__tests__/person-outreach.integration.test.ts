import { afterAll, beforeAll, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";

/**
 * The outreach side of a contact delete ("Contacts and Companies CRUD" in docs/decisions.md): the blockers with an injected
 * clock, the counts as the actor sees them, the suppression rule, the enrollment purge and the merge preview's campaign
 * count. Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describeDb("contact delete: outreach blockers, counts, suppression and purge", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let outreach: typeof import("../person-outreach");
  let db: typeof import("@/platform/db/client").db;
  const orgs: string[] = [];
  const users: string[] = [];
  const now = new Date("2026-10-19T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  beforeAll(async () => {
    outreach = await import("../person-outreach");
    db = (await import("@/platform/db/client")).db;
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  const one = async (rows: PromiseLike<Array<{ id: string }>>) => (await rows)[0].id as string;
  const inTx = <T>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) => db.transaction(fn);

  async function organization() {
    const tag = uniqueKey();
    const org = await one(sql`insert into organizations (name, slug) values ('Outreach purge', ${"outreach-purge-" + tag}) returning id`);
    orgs.push(org);
    const user = async (name: string) => {
      const id = await one(sql`insert into users (name, email) values (${name}, ${`${name}-${tag}@x.test`}) returning id`);
      users.push(id);
      return id;
    };
    const member = await user("member");
    const other = await user("other");
    const admin = await user("admin");
    const mailbox = await one(sql`insert into mailboxes (organization_id, email_address, status) values (${org}, ${`box-${tag}@x.test`}, 'connected') returning id`);
    const account = await one(sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id) values (${org}, ${`acc-${tag}`}, ${`li-${tag}`}) returning id`);
    const actors = {
      member: { userId: member, organizationId: org, role: "member" } satisfies Actor,
      other: { userId: other, organizationId: org, role: "member" } satisfies Actor,
      admin: { userId: admin, organizationId: org, role: "admin" } satisfies Actor,
    };
    return { org, tag, mailbox, account, actors };
  }
  type Org = Awaited<ReturnType<typeof organization>>;

  let campaignNo = 0;
  async function campaign(o: Org, opts: { channel?: "email" | "linkedin"; type?: "regular" | "personal"; createdBy?: string; status?: string } = {}) {
    campaignNo += 1;
    const channel = opts.channel ?? "email";
    return one(sql`
      insert into campaigns (organization_id, channel, name, type, status, created_by)
      values (${o.org}, ${channel}, ${`C${campaignNo}`}, ${opts.type ?? "regular"}, ${opts.status ?? "active"}, ${opts.createdBy ?? null}) returning id`);
  }

  /** A person; a contact unless `lead` is set. Enrollments for a contact go in as `completed`, which the contact guard allows. */
  async function person(o: Org, label: string, opts: { lead?: boolean; companyId?: string } = {}) {
    const email = `${o.tag}-${label}@lead.test`;
    const id = await one(sql`
      insert into people (organization_id, email, full_name, lifecycle, converted_at, company_id)
      values (${o.org}, ${email}, ${label}, ${opts.lead ? "lead" : "contact"}, ${opts.lead ? null : now.toISOString()}, ${opts.companyId ?? null}) returning id`);
    return { id, email };
  }

  async function enroll(o: Org, campaignId: string, personId: string, status = "completed", channel: "email" | "linkedin" = "email") {
    return one(sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status)
      values (${o.org}, ${campaignId}, ${personId}, ${channel}, ${status}) returning id`);
  }

  async function send(o: Org, enrollmentId: string, step: number, claimedAt: string, opts: { channel?: "email" | "linkedin"; status?: string } = {}) {
    const channel = opts.channel ?? "email";
    return one(sql`
      insert into sends (organization_id, kind, enrollment_id, step_number, channel, status, mailbox_id, linkedin_account_id, claimed_at)
      values (${o.org}, 'campaign', ${enrollmentId}, ${step}, ${channel}, ${opts.status ?? "sent"},
              ${channel === "email" ? o.mailbox : null}, ${channel === "linkedin" ? o.account : null}, ${claimedAt}) returning id`);
  }

  const blockers = (actor: Actor, personId: string) => inTx((tx) => outreach.personOutreachBlockers(tx, actor, personId, now));
  const reasons = async (actor: Actor, personId: string) => (await blockers(actor, personId)).map((b) => b.reason);

  it("blocks on a campaign send claimed 23 hours ago and not on one claimed 25 hours ago", async () => {
    const o = await organization();
    const c = await campaign(o);
    const recent = await person(o, "recent");
    await send(o, await enroll(o, c, recent.id), 1, ago(23 * HOUR));
    const older = await person(o, "older");
    await send(o, await enroll(o, c, older.id), 1, ago(25 * HOUR));

    const found = await blockers(o.actors.member, recent.id);
    expect(found).toEqual([{ reason: "recent_send", until: new Date(now.getTime() + HOUR) }]);
    expect(await reasons(o.actors.member, older.id)).toEqual([]);
  });

  it("does not count a test send to the person's address as a campaign send", async () => {
    const o = await organization();
    const c = await campaign(o);
    const contact = await person(o, "tested");
    await send(o, await enroll(o, c, contact.id), 1, ago(3 * DAY));
    await sql`
      insert into sends (organization_id, kind, channel, status, mailbox_id, to_address, claimed_at)
      values (${o.org}, 'test', 'email', 'sent', ${o.mailbox}, ${contact.email}, ${ago(HOUR)})`;
    expect(await reasons(o.actors.member, contact.id)).toEqual([]);
  });

  it("blocks on a LinkedIn invitation claimed 6 days ago and not on one claimed 8 days ago", async () => {
    const o = await organization();
    const c = await campaign(o, { channel: "linkedin" });
    const recent = await person(o, "invited");
    await send(o, await enroll(o, c, recent.id, "completed", "linkedin"), 1, ago(6 * DAY), { channel: "linkedin" });
    const older = await person(o, "invited-long-ago");
    await send(o, await enroll(o, c, older.id, "completed", "linkedin"), 1, ago(8 * DAY), { channel: "linkedin" });
    // A LinkedIn message (step 2) 6 days ago is not an invitation.
    const messaged = await person(o, "messaged");
    const e = await enroll(o, c, messaged.id, "completed", "linkedin");
    await send(o, e, 1, ago(9 * DAY), { channel: "linkedin" });
    await send(o, e, 2, ago(6 * DAY), { channel: "linkedin" });

    expect(await blockers(o.actors.member, recent.id)).toEqual([{ reason: "recent_invite", until: new Date(now.getTime() + DAY) }]);
    expect(await reasons(o.actors.member, older.id)).toEqual([]);
    expect(await reasons(o.actors.member, messaged.id)).toEqual([]);
  });

  it("blocks on a send in flight, sending or unknown", async () => {
    const o = await organization();
    const c = await campaign(o);
    for (const status of ["sending", "unknown"]) {
      const p = await person(o, `flight-${status}`);
      await send(o, await enroll(o, c, p.id), 1, ago(2 * DAY), { status });
      expect(await reasons(o.actors.member, p.id)).toEqual(["send_in_flight"]);
    }
  });

  it("blocks a member on another member's personal campaign and lets the creator and an admin through", async () => {
    const o = await organization();
    const personal = await campaign(o, { channel: "linkedin", type: "personal", createdBy: o.actors.other.userId });
    const p = await person(o, "personal");
    await send(o, await enroll(o, personal, p.id, "completed", "linkedin"), 1, ago(10 * DAY), { channel: "linkedin" });

    expect(await reasons(o.actors.member, p.id)).toEqual(["personal_campaign_sends"]);
    expect(await reasons(o.actors.other, p.id)).toEqual([]);
    expect(await reasons(o.actors.admin, p.id)).toEqual([]);

    // An enrollment with no send yet blocks too, and so does a personal campaign whose creator left.
    const orphan = await campaign(o, { channel: "linkedin", type: "personal" });
    const q = await person(o, "orphaned");
    await enroll(o, orphan, q.id, "cancelled", "linkedin");
    expect(await reasons(o.actors.member, q.id)).toEqual(["personal_campaign_sends"]);
    expect(await reasons(o.actors.admin, q.id)).toEqual([]);
  });

  it("counts enrollments and sends as the actor may see them", async () => {
    const o = await organization();
    const regular = await campaign(o);
    const personal = await campaign(o, { channel: "linkedin", type: "personal", createdBy: o.actors.other.userId });
    const p = await person(o, "counted");
    const e1 = await enroll(o, regular, p.id);
    await send(o, e1, 1, ago(5 * DAY));
    await send(o, e1, 2, ago(4 * DAY));
    const e2 = await enroll(o, personal, p.id, "completed", "linkedin");
    await send(o, e2, 1, ago(10 * DAY), { channel: "linkedin" });

    const count = (actor: Actor) => inTx((tx) => outreach.personOutreachCounts(tx, actor, p.id));
    expect(await count(o.actors.member)).toEqual({ campaigns: 1, sends: 2, hidden: true });
    expect(await count(o.actors.other)).toEqual({ campaigns: 2, sends: 3, hidden: false });
    expect(await count(o.actors.admin)).toEqual({ campaigns: 2, sends: 3, hidden: false });
  });

  it("keeps a marked contact's email suppressed and leaves an existing row as it is", async () => {
    const o = await organization();
    const keep = (email: string | null, doNotContact: boolean) => inTx((tx) => outreach.keepEmailSuppressed(tx, o.org, { email, doNotContact }));

    expect(await keep(`Marked-${o.tag}@Lead.test`, true)).toBe(true);
    const [marked] = await sql`select reason, note from suppression_list where organization_id = ${o.org} and email = ${`marked-${o.tag}@lead.test`}`;
    expect(marked).toEqual({ reason: "manual", note: "Deleted while marked do not contact." });

    await sql`insert into suppression_list (organization_id, email, reason, note) values (${o.org}, ${`gone-${o.tag}@lead.test`}, 'unsubscribed', 'clicked')`;
    expect(await keep(`gone-${o.tag}@lead.test`, true)).toBe(true);
    expect(await keep(`gone-${o.tag}@lead.test`, false)).toBe(true);
    const existing = await sql`select reason, note from suppression_list where organization_id = ${o.org} and email = ${`gone-${o.tag}@lead.test`}`;
    expect(existing).toEqual([{ reason: "unsubscribed", note: "clicked" }]);

    expect(await keep(`free-${o.tag}@lead.test`, false)).toBe(false);
    expect(await keep(null, true)).toBe(false);
    const [{ n }] = await sql`select count(*)::int as n from suppression_list where organization_id = ${o.org}`;
    expect(n).toBe(2);
  });

  it("purges the person's enrollments with their sends and LinkedIn details and touches no one else", async () => {
    const o = await organization();
    const other = await organization();
    const email = await campaign(o);
    const linkedin = await campaign(o, { channel: "linkedin" });
    const target = await person(o, "target");
    const bystander = await person(o, "bystander");
    const e1 = await enroll(o, email, target.id);
    await send(o, e1, 1, ago(5 * DAY));
    await send(o, e1, 2, ago(4 * DAY));
    const e2 = await enroll(o, linkedin, target.id, "completed", "linkedin");
    await send(o, e2, 1, ago(10 * DAY), { channel: "linkedin" });
    await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, connection_state) values (${e2}, ${o.org}, 'connected')`;
    const connection = await one(sql`
      insert into linkedin_connections (organization_id, linkedin_account_id, provider_id, enrollment_id) values (${o.org}, ${o.account}, ${`prov-${o.tag}`}, ${e2}) returning id`);
    const b1 = await enroll(o, email, bystander.id);
    await send(o, b1, 1, ago(5 * DAY));
    const elsewhere = await person(other, "elsewhere");
    await send(other, await enroll(other, await campaign(other), elsewhere.id), 1, ago(5 * DAY));
    await sql`insert into sends (organization_id, kind, channel, status, mailbox_id, to_address) values (${o.org}, 'test', 'email', 'sent', ${o.mailbox}, ${target.email})`;

    const before = await sql`select organization_id, count(*)::int as n from sends where organization_id in (${o.org}, ${other.org}) group by organization_id`;
    expect(Object.fromEntries(before.map((r) => [r.organization_id, r.n]))).toEqual({ [o.org]: 5, [other.org]: 1 });

    expect(await inTx((tx) => outreach.purgePersonOutreach(tx, o.org, target.id))).toEqual({ enrollments: 2, sends: 3 });

    const [left] = await sql`
      select
        (select count(*)::int from campaign_enrollments where person_id = ${target.id}) as enrollments,
        (select count(*)::int from sends where enrollment_id in (${e1}, ${e2})) as sends,
        (select count(*)::int from linkedin_enrollment_details where enrollment_id = ${e2}) as details,
        (select enrollment_id from linkedin_connections where id = ${connection}) as connection_enrollment,
        (select count(*)::int from sends where organization_id = ${o.org}) as org_sends,
        (select count(*)::int from sends where organization_id = ${other.org}) as other_sends,
        (select count(*)::int from campaign_enrollments where person_id = ${bystander.id}) as bystander`;
    expect(left).toEqual({ enrollments: 0, sends: 0, details: 0, connection_enrollment: null, org_sends: 2, other_sends: 1, bystander: 1 });
    expect(await inTx((tx) => outreach.purgePersonOutreach(tx, o.org, target.id))).toEqual({ enrollments: 0, sends: 0 });
  });

  it("counts a company's leads in running campaigns for the merge preview", async () => {
    const o = await organization();
    const company = await one(sql`insert into companies (organization_id, domain, name) values (${o.org}, ${`acme-${o.tag}.com`}, 'Acme') returning id`);
    const running = await campaign(o);
    const second = await campaign(o);
    const paused = await campaign(o, { status: "paused" });
    const a = await person(o, "a", { lead: true, companyId: company });
    await enroll(o, running, a.id, "active");
    await enroll(o, second, a.id, "pending");
    const b = await person(o, "b", { lead: true, companyId: company });
    await enroll(o, paused, b.id, "active");
    const c = await person(o, "c", { lead: true, companyId: company });
    await enroll(o, running, c.id, "completed");
    const d = await person(o, "d", { lead: true });
    await enroll(o, running, d.id, "active");
    const contact = await person(o, "contact", { companyId: company });
    await enroll(o, running, contact.id, "completed");

    expect(await outreach.leadsInRunningCampaigns(o.org, company)).toBe(1);
  });
});
