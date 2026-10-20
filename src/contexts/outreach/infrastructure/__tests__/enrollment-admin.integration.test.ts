import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import type { EngineDeps } from "../../email/application/send-next-email";
import type { LinkedInEngineDeps } from "../../linkedin/application/linkedin-ports";
import { FakeLinkedInGateway } from "../../linkedin/infrastructure/fake-linkedin-gateway";
import { FakeMailboxProvider } from "../../email/infrastructure/fake-mailbox-provider";
import { createTestOrg, describeDb, dropOrgs, type TestOrg, testSql, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const EMAIL_STEPS = [
  { stepNumber: 1, kind: "email", subject: "Hi {{firstName}}", body: "Hello {{firstName}}", waitDays: 0 },
  { stepNumber: 2, kind: "email", subject: "Following up, {{firstName}}", body: "Following up", waitDays: 2 },
];
const LINKEDIN_STEPS = [
  { stepNumber: 1, kind: "invitation", body: "Hi {{firstName}}, let us connect", waitDays: 0 },
  { stepNumber: 2, kind: "message", body: "Thanks {{firstName}}", waitDays: 1 },
];

describeDb("enrollment admin: picked enroll, remove, senders", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let email: typeof import("../../application/campaign-management");
  let linkedin: typeof import("../../linkedin/application/linkedin-campaigns");
  let sendEmail: typeof import("../../email/application/send-next-email");
  let liEngine: typeof import("../../linkedin/application/send-next-linkedin");
  let emailStore: typeof import("../drizzle-outreach-store").drizzleOutreachStore;
  let liStore: typeof import("../../linkedin/infrastructure/drizzle-linkedin-store").drizzleLinkedInStore;
  let stores: typeof import("../drizzle-management-stores");
  let liCampaignStore: typeof import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store").drizzleLinkedInCampaignStore;
  let admin: typeof import("../drizzle-enrollment-admin").drizzleEnrollmentAdminStore;
  const orgs: TestOrg[] = [];

  const start = new Date("2026-10-14T10:00:00Z");
  let current = start;
  const clock = { now: () => current };
  const advance = (minutes: number) => {
    current = new Date(current.getTime() + minutes * 60_000);
  };
  const engineDeps = (provider: FakeMailboxProvider): EngineDeps => ({ store: emailStore, provider, clock, random: () => 0, appUrl: "https://app.test", unsubscribeSecret: "u".repeat(40) });
  const liDeps = (gateway: FakeLinkedInGateway): LinkedInEngineDeps => ({ store: liStore, gateways: gateway, clock, random: () => 0 });
  const emailUc = () => ({ campaigns: stores.drizzleCampaignStore, mailboxes: stores.drizzleMailboxStore, admin, now: () => current });
  const liUc = () => ({ campaigns: liCampaignStore, admin, now: () => current });

  async function newOrg() {
    current = start;
    const tag = Math.random().toString(36).slice(2, 8);
    const created = await createTestOrg(sql, "A");
    orgs.push(created);
    const { organizationId: org, userId } = created;
    const actor: Actor = { userId, organizationId: org, role: "owner" };
    return { org, tag, actor };
  }
  type T = Awaited<ReturnType<typeof newOrg>>;

  const mailbox = async (t: T, name: string, status = "connected") =>
    (
      await sql`
        insert into mailboxes (organization_id, email_address, display_name, status, daily_send_limit, working_hours)
        values (${t.org}, ${`${name}-${t.tag}@corp.test`}, 'S', ${status}, 30, ${sql.json({ timeZone: "UTC", days: ALL_DAY })}) returning id`
    )[0].id as string;
  const account = async (t: T, name: string, status = "connected") =>
    (
      await sql`
        insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, status, daily_invite_limit, working_hours)
        values (${t.org}, ${`acct-${name}-${t.tag}`}, ${`ACo-${name}-${t.tag}`}, ${`${name}-${t.tag}`}, ${status}, 20, ${sql.json({ timeZone: "UTC", days: ALL_DAY })}) returning id`
    )[0].id as string;
  const campaign = async (t: T, channel: "email" | "linkedin", status = "active") =>
    (await sql`insert into campaigns (organization_id, channel, name, status, steps) values (${t.org}, ${channel}, 'c', ${status}, ${sql.json((channel === "email" ? EMAIL_STEPS : LINKEDIN_STEPS) as never)}) returning id`)[0].id as string;
  const person = async (t: T, tagName: string, fields: { email?: string | null; slug?: string | null } = {}) =>
    (
      await sql`
        insert into people (organization_id, email, linkedin_slug, first_name, full_name)
        values (${t.org}, ${fields.email === undefined ? `${tagName}-${t.tag}@acme.test` : fields.email}, ${fields.slug === undefined ? `${tagName}-${t.tag}` : fields.slug}, ${tagName}, ${tagName + " Test"}) returning id`
    )[0].id as string;
  const enrolled = async (t: T, campaignId: string, personId: string, channel: "email" | "linkedin", status = "pending") => {
    const [{ id }] = await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${t.org}, ${campaignId}, ${personId}, ${channel}, ${status}) returning id`;
    if (channel === "linkedin") await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, profile_url) values (${id}, ${t.org}, 'https://www.linkedin.com/in/x')`;
    return id as string;
  };
  const row = async (id: string) => (await sql`select * from campaign_enrollments where id = ${id}`)[0];

  beforeAll(async () => {
    email = await import("../../application/campaign-management");
    linkedin = await import("../../linkedin/application/linkedin-campaigns");
    sendEmail = await import("../../email/application/send-next-email");
    liEngine = await import("../../linkedin/application/send-next-linkedin");
    ({ drizzleOutreachStore: emailStore } = await import("../drizzle-outreach-store"));
    ({ drizzleLinkedInStore: liStore } = await import("../../linkedin/infrastructure/drizzle-linkedin-store"));
    stores = await import("../drizzle-management-stores");
    ({ drizzleLinkedInCampaignStore: liCampaignStore } = await import("../../linkedin/infrastructure/drizzle-linkedin-campaign-store"));
    ({ drizzleEnrollmentAdminStore: admin } = await import("../drizzle-enrollment-admin"));
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("enrollment status check", () => {
    it("allows the removed status and still rejects an unknown one", async () => {
      const t = await newOrg();
      const c = await campaign(t, "email");
      const id = await enrolled(t, c, await person(t, "a"), "email");
      await sql`update campaign_enrollments set status = 'removed' where id = ${id}`;
      await expect(sql`update campaign_enrollments set status = 'gone' where id = ${id}`).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("enroll picked people", () => {
    it("counts added, duplicate, missing email, suppressed, do-not-contact and not found, and every id lands once", async () => {
      const t = await newOrg();
      const c = await campaign(t, "email", "draft");
      const ok = await person(t, "ok");
      const dup = await person(t, "dup");
      const noEmail = await person(t, "noemail", { email: null });
      const sup = await person(t, "sup");
      const dnc = await person(t, "dnc");
      await enrolled(t, c, dup, "email");
      await sql`insert into suppression_list (organization_id, email, reason) values (${t.org}, ${`sup-${t.tag}@acme.test`}, 'manual')`;
      await sql`insert into contact_policies (organization_id, person_id, do_not_contact, source, set_at) values (${t.org}, ${dnc}, true, 'human', now())`;
      const ghost = "00000000-0000-4000-8000-000000000000";

      const result = await email.enrollPickedLeads(emailUc(), t.actor, c, [ok, dup, noEmail, sup, dnc, ghost, ok]);
      expect(result).toMatchObject({ requested: 6, added: 1, skippedDuplicate: 1, skippedMissingIdentity: 1, skippedSuppressed: 1, skippedDoNotContact: 1, skippedNotFound: 1 });
      expect(result).toMatchObject({ alreadyEnrolled: 1, skippedNoEmail: 1 });
      const sum = result.added + result.skippedDuplicate + result.skippedMissingIdentity + result.skippedSuppressed + result.skippedDoNotContact + result.skippedNotFound;
      expect(sum).toBe(result.requested);
      expect((await sql`select 1 from campaign_enrollments where campaign_id = ${c} and person_id = ${ok} and status = 'pending' and channel = 'email'`).length).toBe(1);
      // A repeat adds nobody.
      expect(await email.enrollPickedLeads(emailUc(), t.actor, c, [ok])).toMatchObject({ added: 0, skippedDuplicate: 1 });
    });

    it("treats people of another organization as not found and enrolls nobody from it", async () => {
      const mine = await newOrg();
      const other = await newOrg();
      const c = await campaign(mine, "email", "draft");
      const foreign = await person(other, "foreign");
      const own = await person(mine, "own");
      const result = await email.enrollPickedLeads(emailUc(), mine.actor, c, [foreign, own]);
      expect(result).toMatchObject({ requested: 2, added: 1, skippedNotFound: 1 });
      expect((await sql`select 1 from campaign_enrollments where person_id = ${foreign}`).length).toBe(0);
      // The same answer as an id that never existed, so the response does not confirm the id exists elsewhere.
      const ghost = await email.enrollPickedLeads(emailUc(), mine.actor, c, ["00000000-0000-4000-8000-000000000001"]);
      expect(ghost).toMatchObject({ requested: 1, added: 0, skippedNotFound: 1 });
      // A campaign of another organization is not found.
      const foreignCampaign = await campaign(other, "email", "draft");
      await expect(email.enrollPickedLeads(emailUc(), mine.actor, foreignCampaign, [own])).rejects.toBeInstanceOf(NotFoundError);
    });

    it("refuses an empty list, more than 500 ids and a completed campaign", async () => {
      const t = await newOrg();
      const c = await campaign(t, "email", "draft");
      await expect(email.enrollPickedLeads(emailUc(), t.actor, c, [])).rejects.toBeInstanceOf(ValidationError);
      await expect(email.enrollPickedLeads(emailUc(), t.actor, c, Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`))).rejects.toBeInstanceOf(ValidationError);
      const done = await campaign(t, "email", "completed");
      await expect(email.enrollPickedLeads(emailUc(), t.actor, done, [await person(t, "x")])).rejects.toThrow(/completed/);
    });

    it("enrolls LinkedIn people with their progress row and counts a missing profile and a foreign id", async () => {
      const t = await newOrg();
      const other = await newOrg();
      const c = await campaign(t, "linkedin", "draft");
      const ok = await person(t, "ok", { email: null });
      const noSlug = await person(t, "noslug", { slug: null });
      const dnc = await person(t, "dnc");
      await sql`insert into contact_policies (organization_id, person_id, do_not_contact, source, set_at) values (${t.org}, ${dnc}, true, 'human', now())`;
      const foreign = await person(other, "foreign");
      const result = await linkedin.enrollPickedLinkedInLeads(liUc(), t.actor, c, [ok, noSlug, dnc, foreign]);
      expect(result).toMatchObject({ requested: 4, added: 1, skippedMissingIdentity: 1, skippedNoProfile: 1, skippedDoNotContact: 1, skippedNotFound: 1, skippedSuppressed: 0 });
      const [enrollment] = await sql`select e.id, d.profile_url from campaign_enrollments e join linkedin_enrollment_details d on d.enrollment_id = e.id where e.person_id = ${ok}`;
      expect(enrollment.profile_url).toMatch(/linkedin\.com\/in\/ok-/);
      expect((await sql`select 1 from campaign_enrollments where person_id = ${foreign}`).length).toBe(0);
    });
  });

  describe("remove enrollments", () => {
    it("removes pending and active leads, keeps history and the person, and is idempotent", async () => {
      const t = await newOrg();
      const c = await campaign(t, "email");
      const p = await person(t, "p");
      const pending = await enrolled(t, c, await person(t, "pending"), "email", "pending");
      const keep = await enrolled(t, c, p, "email", "active");
      await sql`update campaign_enrollments set next_send_at = now(), current_step = 1 where id = ${keep}`;
      const [sentRow] = await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, claimed_at) values (${t.org}, ${keep}, 1, 'email', 'sent', now()) returning id`;

      const result = await email.removeLeads(emailUc(), t.actor, c, [pending, keep]);
      expect(result).toEqual({ requested: 2, removed: 2, alreadyRemoved: 0, skippedFinal: 0, notFound: 0 });
      for (const id of [pending, keep]) expect(await row(id)).toMatchObject({ status: "removed", next_send_at: null, stop_reason: "removed" });
      expect((await row(keep)).current_step).toBe(1);
      expect((await sql`select status from sends where id = ${sentRow.id}`)[0].status).toBe("sent");
      expect((await sql`select 1 from people where id = ${p}`).length).toBe(1);

      expect(await email.removeLeads(emailUc(), t.actor, c, [keep])).toEqual({ requested: 1, removed: 0, alreadyRemoved: 1, skippedFinal: 0, notFound: 0 });
      expect(await email.removeLead(emailUc(), t.actor, c, keep)).toEqual({ removed: false, skippedFinal: false });
    });

    it("leaves replied, bounced, suppressed, completed, failed and cancelled leads as they are and reports them as skippedFinal", async () => {
      const t = await newOrg();
      const c = await campaign(t, "email");
      const finals = ["replied", "bounced", "suppressed", "completed", "failed", "cancelled"];
      const ids: string[] = [];
      for (const status of finals) {
        const id = await enrolled(t, c, await person(t, status), "email", status);
        await sql`update campaign_enrollments set stop_reason = ${status} where id = ${id}`;
        ids.push(id);
      }
      const live = await enrolled(t, c, await person(t, "live"), "email", "active");
      const result = await email.removeLeads(emailUc(), t.actor, c, [...ids, live]);
      expect(result).toEqual({ requested: 7, removed: 1, alreadyRemoved: 0, skippedFinal: 6, notFound: 0 });
      for (const [i, status] of finals.entries()) expect(await row(ids[i])).toMatchObject({ status, stop_reason: status });
      expect((await row(live)).status).toBe("removed");
      expect(await email.removeLead(emailUc(), t.actor, c, ids[0])).toEqual({ removed: false, skippedFinal: true });
      expect((await row(ids[0])).status).toBe("replied");

      const li = await campaign(t, "linkedin");
      const replied = await enrolled(t, li, await person(t, "lir"), "linkedin", "replied");
      expect(await linkedin.removeLinkedInLeads(liUc(), t.actor, li, [replied])).toEqual({ requested: 1, removed: 0, alreadyRemoved: 0, skippedFinal: 1, notFound: 0 });
      expect((await row(replied)).status).toBe("replied");
    });

    it("answers not found for an enrollment of another campaign, channel or organization", async () => {
      const mine = await newOrg();
      const other = await newOrg();
      const c = await campaign(mine, "email");
      const sibling = await campaign(mine, "email");
      const li = await campaign(mine, "linkedin");
      const foreignCampaign = await campaign(other, "email");
      const inSibling = await enrolled(mine, sibling, await person(mine, "a"), "email");
      const inLinkedIn = await enrolled(mine, li, await person(mine, "b"), "linkedin");
      const foreign = await enrolled(other, foreignCampaign, await person(other, "c"), "email");

      const result = await email.removeLeads(emailUc(), mine.actor, c, [inSibling, inLinkedIn, foreign]);
      expect(result).toEqual({ requested: 3, removed: 0, alreadyRemoved: 0, skippedFinal: 0, notFound: 3 });
      expect((await row(foreign)).status).toBe("pending");
      expect((await row(inSibling)).status).toBe("pending");
      await expect(email.removeLead(emailUc(), mine.actor, c, foreign)).rejects.toBeInstanceOf(NotFoundError);
      // The email path cannot touch a LinkedIn campaign, and the LinkedIn path cannot touch an email one.
      await expect(email.removeLeads(emailUc(), mine.actor, li, [inLinkedIn])).rejects.toBeInstanceOf(NotFoundError);
      expect(await linkedin.removeLinkedInLeads(liUc(), mine.actor, c, [inSibling]).catch((e) => e)).toBeInstanceOf(NotFoundError);
      // The store pins the channel as well, in case a caller skips the campaign lookup.
      expect(await admin.removeEnrollments(mine.org, li, "email", [inLinkedIn], current)).toMatchObject({ removed: 0, notFound: 1 });
      expect((await row(inLinkedIn)).status).toBe("pending");
    });

    it("sends nothing for a removed enrollment", async () => {
      const t = await newOrg();
      const m = await mailbox(t, "a");
      const c = await campaign(t, "email");
      const e1 = await enrolled(t, c, await person(t, "one"), "email");
      const e2 = await enrolled(t, c, await person(t, "two"), "email", "active");
      await sql`update campaign_enrollments set mailbox_id = ${m}, current_step = 1, next_send_at = ${current} where id = ${e2}`;
      await email.removeLeads(emailUc(), t.actor, c, [e1, e2]);
      const provider = new FakeMailboxProvider();
      advance(60 * 24 * 3);
      expect((await sendEmail.sendNextEmail(engineDeps(provider), m)).kind).toBe("idle");
      expect(provider.delivered).toHaveLength(0);
      expect((await sql`select 1 from sends where enrollment_id in (${e1}, ${e2})`).length).toBe(0);
    });

    it("drops a claim taken before the removal and keeps the removed status", async () => {
      const t = await newOrg();
      const m = await mailbox(t, "a");
      const c = await campaign(t, "email");
      const e = await enrolled(t, c, await person(t, "one"), "email");
      const claim = await emailStore.claimNext({ mailboxId: m, now: current, pickGapMinutes: () => 0, takeoverAfterHours: () => 24, defaultWorkingHours: () => ({ timeZone: "UTC", days: ALL_DAY as never }) });
      expect(claim?.enrollmentId).toBe(e);
      await email.removeLead(emailUc(), t.actor, c, e);
      expect(await emailStore.checkBlockers(claim as never)).toBe("enrollment_stopped");
      await emailStore.abandon(claim as never, "enrollment_stopped", current);
      expect((await row(e)).status).toBe("removed");
      expect((await sql`select status from sends where enrollment_id = ${e}`)[0].status).toBe("failed");
    });

    it("keeps a removed LinkedIn lead out of every engine step and its status after late writes", async () => {
      const t = await newOrg();
      const a = await account(t, "a");
      const c = await campaign(t, "linkedin");
      const e1 = await enrolled(t, c, await person(t, "one"), "linkedin");
      const e2 = await enrolled(t, c, await person(t, "two"), "linkedin");
      await linkedin.removeLinkedInLeads(liUc(), t.actor, c, [e1]);
      const gateway = new FakeLinkedInGateway();
      // Only the second lead is resolved, then invited.
      expect((await liEngine.runNextLinkedInAction(liDeps(gateway), a)).kind).toBe("resolved");
      advance(2);
      expect((await liEngine.runNextLinkedInAction(liDeps(gateway), a)).kind).toBe("sent");
      expect(gateway.invitations).toHaveLength(1);
      expect((await sql`select 1 from sends where enrollment_id = ${e1}`).length).toBe(0);
      expect((await row(e2)).status).toBe("active");

      // A lead removed between claim and send is blocked, and late engine writes leave `removed` alone.
      expect(await liStore.checkBlockers({ enrollmentId: e1, campaignId: c, organizationId: t.org, person: { id: "x" } } as never)).toBe("enrollment_stopped");
      await liStore.markResolveFailed({ enrollmentId: e1, failures: 9 } as never, "boom", current, true);
      await sql`update campaign_enrollments set status = 'removed' where id = ${e2}`;
      await liStore.markResolveFailed({ enrollmentId: e2, failures: 9 } as never, "boom", current, true);
      expect((await row(e1)).status).toBe("removed");
      expect((await row(e2)).status).toBe("removed");
    });

    it("removes LinkedIn leads and clears the pending lookup", async () => {
      const t = await newOrg();
      const c = await campaign(t, "linkedin");
      const e = await enrolled(t, c, await person(t, "one"), "linkedin");
      await sql`update linkedin_enrollment_details set resolve_next_attempt_at = now() where enrollment_id = ${e}`;
      expect(await linkedin.removeLinkedInLeads(liUc(), t.actor, c, [e])).toEqual({ requested: 1, removed: 1, alreadyRemoved: 0, skippedFinal: 0, notFound: 0 });
      expect((await sql`select resolve_next_attempt_at from linkedin_enrollment_details where enrollment_id = ${e}`)[0].resolve_next_attempt_at).toBeNull();
      expect(await linkedin.removeLinkedInLead(liUc(), t.actor, c, e)).toEqual({ removed: false, skippedFinal: false });
    });

    it("does not break the final-status guard on sends", async () => {
      const t = await newOrg();
      const c = await campaign(t, "email");
      const e = await enrolled(t, c, await person(t, "one"), "email", "active");
      const [{ id: sendId }] = await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, claimed_at) values (${t.org}, ${e}, 1, 'email', 'sent', now()) returning id`;
      await email.removeLead(emailUc(), t.actor, c, e);
      await expect(sql`update sends set status = 'sending' where id = ${sendId}`).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("senders per campaign", () => {
    it("limits an email campaign to the assigned mailboxes", async () => {
      const t = await newOrg();
      const a = await mailbox(t, "a");
      const b = await mailbox(t, "b");
      const c = await campaign(t, "email");
      await enrolled(t, c, await person(t, "one"), "email");
      await email.updateCampaign(emailUc(), t.actor, c, { senderIds: [b] });
      expect((await email.getCampaignSenders(emailUc(), t.actor, c)).assigned.map((s) => s.id)).toEqual([b]);

      const provider = new FakeMailboxProvider();
      expect((await sendEmail.sendNextEmail(engineDeps(provider), a)).kind).toBe("idle");
      expect((await sendEmail.sendNextEmail(engineDeps(provider), b)).kind).toBe("sent");
      expect(provider.delivered).toHaveLength(1);
    });

    it("moves a lead pinned to a mailbox outside the list to a listed one", async () => {
      const t = await newOrg();
      const a = await mailbox(t, "a");
      const b = await mailbox(t, "b");
      const c = await campaign(t, "email");
      const e = await enrolled(t, c, await person(t, "one"), "email", "active");
      await sql`update campaign_enrollments set mailbox_id = ${a}, current_step = 1, next_send_at = ${current} where id = ${e}`;
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, mailbox_id, sent_at, claimed_at) values (${t.org}, ${e}, 1, 'email', 'sent', ${a}, now(), now())`;
      await email.updateCampaign(emailUc(), t.actor, c, { senderIds: [b] });
      const provider = new FakeMailboxProvider();
      expect((await sendEmail.sendNextEmail(engineDeps(provider), a)).kind).toBe("idle");
      const out = await sendEmail.sendNextEmail(engineDeps(provider), b);
      expect(out.kind).toBe("sent");
      expect((await row(e)).mailbox_id).toBe(b);
    });

    it("sends from any connected mailbox when the list is empty, and clearing the list restores that", async () => {
      const t = await newOrg();
      const a = await mailbox(t, "a");
      const b = await mailbox(t, "b");
      const c = await campaign(t, "email");
      await enrolled(t, c, await person(t, "one"), "email");
      const provider = new FakeMailboxProvider();
      await email.updateCampaign(emailUc(), t.actor, c, { senderIds: [b] });
      expect((await sendEmail.sendNextEmail(engineDeps(provider), a)).kind).toBe("idle");
      await email.updateCampaign(emailUc(), t.actor, c, { senderIds: [] });
      expect((await sql`select 1 from campaign_senders where campaign_id = ${c}`).length).toBe(0);
      expect((await sendEmail.sendNextEmail(engineDeps(provider), a)).kind).toBe("sent");
    });

    it("rejects a mailbox of another organization or one that is not connected, on create and on update", async () => {
      const t = await newOrg();
      const other = await newOrg();
      const foreign = await mailbox(other, "f");
      const down = await mailbox(t, "down", "failed");
      const good = await mailbox(t, "good");
      const c = await campaign(t, "email", "draft");
      await expect(email.createCampaign(emailUc(), t.actor, { name: "x", senderIds: [foreign] })).rejects.toBeInstanceOf(ValidationError);
      await expect(email.createCampaign(emailUc(), t.actor, { name: "x", senderIds: [down] })).rejects.toThrow(/Reconnect or remove/);
      await expect(email.updateCampaign(emailUc(), t.actor, c, { senderIds: [foreign] })).rejects.toBeInstanceOf(ValidationError);
      expect((await sql`select 1 from campaigns where organization_id = ${t.org} and name = 'x'`).length).toBe(0);
      const created = await email.createCampaign(emailUc(), t.actor, { name: "ok", senderIds: [good, good] });
      expect((await sql`select mailbox_id from campaign_senders where campaign_id = ${created.id}`).map((r) => r.mailbox_id)).toEqual([good]);
    });

    it("refuses to launch while an assigned mailbox is not connected", async () => {
      const t = await newOrg();
      const a = await mailbox(t, "a");
      await mailbox(t, "spare");
      const c = await campaign(t, "email", "draft");
      await email.updateCampaign(emailUc(), t.actor, c, { senderIds: [a] });
      await sql`update mailboxes set status = 'failed' where id = ${a}`;
      await expect(email.changeCampaignStatus(emailUc(), t.actor, c, "active")).rejects.toThrow(/Every assigned mailbox must be connected before starting\. Reconnect or remove a-/);
      await sql`update mailboxes set status = 'connected' where id = ${a}`;
      await email.changeCampaignStatus(emailUc(), t.actor, c, "active");
      expect((await sql`select status from campaigns where id = ${c}`)[0].status).toBe("active");
    });

    it("limits a LinkedIn campaign to the assigned accounts and restores the default for an empty list", async () => {
      const t = await newOrg();
      const a = await account(t, "a");
      const b = await account(t, "b");
      const c = await campaign(t, "linkedin");
      const e = await enrolled(t, c, await person(t, "one"), "linkedin");
      await linkedin.updateLinkedInCampaign(liUc(), t.actor, c, { senderIds: [b] });
      const gateway = new FakeLinkedInGateway();
      expect((await liEngine.runNextLinkedInAction(liDeps(gateway), a)).kind).toBe("idle");
      expect((await liEngine.runNextLinkedInAction(liDeps(gateway), b)).kind).toBe("resolved");
      expect((await row(e)).linkedin_account_id).toBe(b);

      const t2 = await newOrg();
      const a2 = await account(t2, "a");
      await account(t2, "b");
      const c2 = await campaign(t2, "linkedin");
      await enrolled(t2, c2, await person(t2, "one"), "linkedin");
      expect((await liEngine.runNextLinkedInAction(liDeps(gateway), a2)).kind).toBe("resolved");
    });

    it("validates LinkedIn senders and blocks launch with a disconnected one", async () => {
      const t = await newOrg();
      const other = await newOrg();
      const foreign = await account(other, "f");
      const down = await account(t, "down", "disconnected");
      const good = await account(t, "good");
      const c = await campaign(t, "linkedin", "draft");
      await expect(linkedin.createLinkedInCampaign(liUc(), t.actor, { name: "x", senderIds: [foreign] })).rejects.toBeInstanceOf(ValidationError);
      await expect(linkedin.updateLinkedInCampaign(liUc(), t.actor, c, { senderIds: [down] })).rejects.toThrow(/Reconnect or remove/);
      await linkedin.updateLinkedInCampaign(liUc(), t.actor, c, { senderIds: [good] });
      await sql`update linkedin_accounts set status = 'disconnected' where id = ${good}`;
      await account(t, "spare");
      await expect(linkedin.changeLinkedInCampaignStatus(liUc(), t.actor, c, "active")).rejects.toThrow(/Every assigned LinkedIn account must be connected before starting/);
      await sql`update linkedin_accounts set status = 'connected' where id = ${good}`;
      await linkedin.changeLinkedInCampaignStatus(liUc(), t.actor, c, "active");
    });
  });

  describe("T4 review fixes", () => {
    const linkedinEnrolled = async (t: T, c: string, name: string, accountId: string | null, providerId: string | null) => {
      const e = await enrolled(t, c, await person(t, name), "linkedin");
      await sql`update campaign_enrollments set linkedin_account_id = ${accountId} where id = ${e}`;
      await sql`update linkedin_enrollment_details set provider_id = ${providerId} where enrollment_id = ${e}`;
      return e;
    };
    const setSenders = (c: string, ids: Array<{ account?: string; mailbox?: string }>, t: T) =>
      Promise.all(ids.map((i) => sql`insert into campaign_senders (organization_id, campaign_id, linkedin_account_id, mailbox_id) values (${t.org}, ${c}, ${i.account ?? null}, ${i.mailbox ?? null})`));

    it("keeps an account outside the sender list from inviting a lead pinned to it", async () => {
      const t = await newOrg();
      const a = await account(t, "a");
      const b = await account(t, "b");
      const c = await campaign(t, "linkedin");
      const e = await linkedinEnrolled(t, c, "one", a, "ACo-one");
      await setSenders(c, [{ account: b }], t);
      const gateway = new FakeLinkedInGateway();
      expect((await liEngine.runNextLinkedInAction(liDeps(gateway), a)).kind).toBe("idle");
      expect((await row(e)).status).toBe("pending");
      expect((await sql`select 1 from sends where enrollment_id = ${e}`).length).toBe(0);
    });

    it("keeps an account outside the sender list from messaging a connected lead pinned to it", async () => {
      const t = await newOrg();
      const a = await account(t, "a");
      const b = await account(t, "b");
      const c = await campaign(t, "linkedin");
      const e = await linkedinEnrolled(t, c, "one", a, "ACo-one");
      await sql`update campaign_enrollments set status = 'active', current_step = 1, next_send_at = ${current} where id = ${e}`;
      await sql`update linkedin_enrollment_details set connection_state = 'connected' where enrollment_id = ${e}`;
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id, claimed_at, sent_at) values (${t.org}, ${e}, 1, 'linkedin', 'sent', ${a}, now(), now())`;
      await setSenders(c, [{ account: b }], t);
      const gateway = new FakeLinkedInGateway();
      expect((await liEngine.runNextLinkedInAction(liDeps(gateway), a)).kind).toBe("idle");
      expect((await sql`select 1 from sends where enrollment_id = ${e} and step_number = 2`).length).toBe(0);
    });

    it("unpins pending, not yet invited leads when their account leaves the list, so a listed account resolves them again", async () => {
      const t = await newOrg();
      const a = await account(t, "a");
      const b = await account(t, "b");
      const c = await campaign(t, "linkedin");
      const stale = await linkedinEnrolled(t, c, "stale", a, "ACo-stale");
      const invited = await linkedinEnrolled(t, c, "invited", a, "ACo-invited");
      await sql`update campaign_enrollments set status = 'active', current_step = 1 where id = ${invited}`;
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id, claimed_at, sent_at) values (${t.org}, ${invited}, 1, 'linkedin', 'sent', ${a}, now(), now())`;
      const claimed = await linkedinEnrolled(t, c, "claimed", a, "ACo-claimed");
      await sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, linkedin_account_id, claimed_at) values (${t.org}, ${claimed}, 1, 'linkedin', 'sending', ${a}, now())`;
      const kept = await linkedinEnrolled(t, c, "kept", b, null);

      await linkedin.updateLinkedInCampaign(liUc(), t.actor, c, { senderIds: [b] });

      expect(await row(stale)).toMatchObject({ linkedin_account_id: null, status: "pending" });
      expect((await sql`select provider_id from linkedin_enrollment_details where enrollment_id = ${stale}`)[0].provider_id).toBeNull();
      expect((await row(invited)).linkedin_account_id).toBe(a);
      expect((await row(claimed)).linkedin_account_id).toBe(a);
      expect((await row(kept)).linkedin_account_id).toBe(b);

      const gateway = new FakeLinkedInGateway();
      expect((await liEngine.runNextLinkedInAction(liDeps(gateway), a)).kind).toBe("idle");
      expect((await liEngine.runNextLinkedInAction(liDeps(gateway), b)).kind).toBe("resolved");
      expect((await row(stale)).linkedin_account_id).toBe(b);
    });

    it("keeps pinned leads when the list is cleared", async () => {
      const t = await newOrg();
      const a = await account(t, "a");
      const c = await campaign(t, "linkedin");
      const e = await linkedinEnrolled(t, c, "one", a, "ACo-one");
      await linkedin.updateLinkedInCampaign(liUc(), t.actor, c, { senderIds: [] });
      expect((await row(e)).linkedin_account_id).toBe(a);
    });

    it("reports a removed lead as skippedRemoved and an active one as skippedDuplicate", async () => {
      const t = await newOrg();
      const c = await campaign(t, "email", "draft");
      const gone = await person(t, "gone");
      const here = await person(t, "here");
      await enrolled(t, c, gone, "email", "removed");
      await enrolled(t, c, here, "email", "active");
      const result = await email.enrollPickedLeads(emailUc(), t.actor, c, [gone, here]);
      expect(result).toMatchObject({ requested: 2, added: 0, skippedRemoved: 1, skippedDuplicate: 1 });
      expect((await row((await sql`select id from campaign_enrollments where person_id = ${gone}`)[0].id)).status).toBe("removed");

      const li = await campaign(t, "linkedin", "draft");
      const lgone = await person(t, "lgone");
      await enrolled(t, li, lgone, "linkedin", "removed");
      expect(await linkedin.enrollPickedLinkedInLeads(liUc(), t.actor, li, [lgone])).toMatchObject({ skippedRemoved: 1, skippedDuplicate: 0 });
    });

    describe("mailbox delete", () => {
      const mailboxDeps = () => ({ mailboxes: stores.drizzleMailboxStore, provider: new FakeMailboxProvider(), now: () => current, policy: { allowedDomains: null, openSignup: false } });
      let mailboxUc: typeof import("../../email/application/mailbox-management");
      beforeAll(async () => {
        mailboxUc = await import("../../email/application/mailbox-management");
      });

      it("blocks deleting the only sender of a campaign that is not completed, naming the campaign", async () => {
        const t = await newOrg();
        const a = await mailbox(t, "a");
        await mailbox(t, "spare");
        const c = await campaign(t, "email", "paused");
        await setSenders(c, [{ mailbox: a }], t);
        await expect(mailboxUc.removeMailbox(mailboxDeps(), t.actor, a)).rejects.toSatisfy((e: unknown) => e instanceof ConflictError && /only sender assigned to campaign "c"/.test(e.message));
        expect((await sql`select 1 from mailboxes where id = ${a}`).length).toBe(1);
        expect((await sql`select 1 from campaign_senders where campaign_id = ${c}`).length).toBe(1);
      });

      it("deletes a mailbox that shares a campaign with another sender, or whose campaign is completed", async () => {
        const t = await newOrg();
        const a = await mailbox(t, "a");
        const b = await mailbox(t, "b");
        const shared = await campaign(t, "email", "active");
        await setSenders(shared, [{ mailbox: a }, { mailbox: b }], t);
        await mailboxUc.removeMailbox(mailboxDeps(), t.actor, a);
        expect((await sql`select mailbox_id from campaign_senders where campaign_id = ${shared}`).map((r) => r.mailbox_id)).toEqual([b]);

        const d = await mailbox(t, "d");
        const done = await campaign(t, "email", "completed");
        await setSenders(done, [{ mailbox: d }], t);
        await mailboxUc.removeMailbox(mailboxDeps(), t.actor, d);
        expect((await sql`select 1 from mailboxes where id = ${d}`).length).toBe(0);
      });
    });

    describe("launch subject check", () => {
      const subjectCampaign = async (t: T, status: string, subject = "{{nickname}}") => {
        const c = await campaign(t, "email", status);
        await sql`update campaigns set steps = ${sql.json([{ ...EMAIL_STEPS[0], subject }, EMAIL_STEPS[1]] as never)} where id = ${c}`;
        return c;
      };
      const lead = async (t: T, c: string, name: string, mergeFields: Record<string, string>, status = "pending") => {
        const e = await enrolled(t, c, await person(t, name), "email", status);
        await sql`update campaign_enrollments set merge_fields = ${sql.json(mergeFields)}, created_at = now() + ${name.length} * interval '1 second' where id = ${e}`;
        return e;
      };

      it("blocks a launch when every sampled lead renders an empty subject", async () => {
        const t = await newOrg();
        await mailbox(t, "a");
        const c = await subjectCampaign(t, "draft");
        await lead(t, c, "one", {});
        await lead(t, c, "three", {});
        await expect(email.changeCampaignStatus(emailUc(), t.actor, c, "active")).rejects.toThrow(/subject of step 1 renders empty/);
        expect((await sql`select status from campaigns where id = ${c}`)[0].status).toBe("draft");
      });

      it("launches when some leads render an empty subject, and returns the count", async () => {
        const t = await newOrg();
        await mailbox(t, "a");
        const c = await subjectCampaign(t, "draft");
        await lead(t, c, "one", {}); // oldest lead: the old single-sample check read this one and blocked
        await lead(t, c, "three", { nickname: "Ace" });
        await lead(t, c, "seven", { nickname: "Bo" });
        expect(await email.changeCampaignStatus(emailUc(), t.actor, c, "active")).toEqual({ emptySubjectLeads: 1, sampled: 3 });
        expect((await sql`select status from campaigns where id = ${c}`)[0].status).toBe("active");
      });

      it("applies each enrollment's merge fields and ignores removed leads", async () => {
        const t = await newOrg();
        await mailbox(t, "a");
        const c = await subjectCampaign(t, "draft");
        await lead(t, c, "one", {}, "removed");
        await lead(t, c, "three", { nickname: "Ace" });
        expect(await email.changeCampaignStatus(emailUc(), t.actor, c, "active")).toEqual({ emptySubjectLeads: 0, sampled: 1 });

        const t2 = await newOrg();
        await mailbox(t2, "a");
        const c2 = await subjectCampaign(t2, "draft");
        await lead(t2, c2, "one", { nickname: "Ace" }, "removed");
        await lead(t2, c2, "three", {});
        await expect(email.changeCampaignStatus(emailUc(), t2.actor, c2, "active")).rejects.toThrow(/renders empty/);
      });

      it("does not run the subject check on resume", async () => {
        const t = await newOrg();
        await mailbox(t, "a");
        const c = await subjectCampaign(t, "paused");
        await lead(t, c, "one", {});
        await email.changeCampaignStatus(emailUc(), t.actor, c, "active");
        expect((await sql`select status from campaigns where id = ${c}`)[0].status).toBe("active");
      });
    });

    describe("campaign and sender changes share one transaction", () => {
      const failing = (): typeof admin => ({
        ...admin,
        replaceSenders: async (...args: Parameters<typeof admin.replaceSenders>) => {
          await admin.replaceSenders(...args);
          throw new Error("boom");
        },
      });

      it("rolls back the email campaign update when the sender replacement fails", async () => {
        const t = await newOrg();
        const a = await mailbox(t, "a");
        const c = await campaign(t, "email", "draft");
        await expect(email.updateCampaign({ ...emailUc(), admin: failing() }, t.actor, c, { name: "Renamed", senderIds: [a] })).rejects.toThrow("boom");
        expect((await sql`select name from campaigns where id = ${c}`)[0].name).toBe("c");
        expect((await sql`select 1 from campaign_senders where campaign_id = ${c}`).length).toBe(0);
      });

      it("rolls back the LinkedIn campaign update when the sender replacement fails", async () => {
        const t = await newOrg();
        const a = await account(t, "a");
        const c = await campaign(t, "linkedin", "draft");
        await expect(linkedin.updateLinkedInCampaign({ ...liUc(), admin: failing() }, t.actor, c, { name: "Renamed", senderIds: [a] })).rejects.toThrow("boom");
        expect((await sql`select name from campaigns where id = ${c}`)[0].name).toBe("c");
      });

      it("creates no campaign when the sender assignment fails", async () => {
        const t = await newOrg();
        const a = await mailbox(t, "a");
        const g = await account(t, "g");
        await expect(email.createCampaign({ ...emailUc(), admin: failing() }, t.actor, { name: "Orphan", senderIds: [a] })).rejects.toThrow("boom");
        await expect(linkedin.createLinkedInCampaign({ ...liUc(), admin: failing() }, t.actor, { name: "Orphan", senderIds: [g] })).rejects.toThrow("boom");
        expect((await sql`select 1 from campaigns where organization_id = ${t.org} and name = 'Orphan'`).length).toBe(0);
      });
    });
  });
});
