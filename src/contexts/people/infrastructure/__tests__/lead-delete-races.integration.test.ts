import { sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DbHandle } from "@/platform/db/client";
import { ConflictError } from "@/shared/errors";
import { bootDealsKit, holdLocks, sqlState, waitForLockWaiters, type DealsKit, type DealsOrg } from "@/test-support/deals-test-kit";
import type { ContactDeleteDeps, ContactDeletePreview } from "../../application/contact-delete";
import type { LeadDeleteDeps } from "../../application/lead-ports";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * Person delete races of "Delete" and "Contact delete" in docs/decisions.md, on two connections with the real writers:
 *   a send claim while the delete holds the person's enrollments, and a claim that holds an enrollment when the delete comes;
 *   the reply stop against a bulk lead delete, in both orders and unpaused;
 *   a lead whose only sends failed, under the NO ACTION foreign key from sends to enrollments;
 *   the statements per batch of a 10 000 lead delete.
 * Where the delete must stop at a chosen statement, a port wrapper pauses it in process.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */

const ALL_DAY = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [{ start: "00:00", end: "23:59" }]]));
const STEPS = [{ stepNumber: 1, kind: "email", subject: "Hi {{firstName}}", body: "Hello {{firstName}}", waitDays: 0 }];

describeDb("person delete races", () => {
  let kit: DealsKit;
  let leads: typeof import("../../application/lead-management");
  let contacts: typeof import("../../application/contact-delete");
  let leadDeps: LeadDeleteDeps;
  let contactDeps: ContactDeleteDeps;
  let emailStore: typeof import("@/contexts/outreach/email/infrastructure/drizzle-outreach-store").drizzleOutreachStore;
  let replyStop: typeof import("@/contexts/conversations/after-reply/infrastructure/sequence-stop").stopPersonOutreachOnReplyTx;
  let db: typeof import("@/platform/db/client").db;

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    leads = await import("../../application/lead-management");
    contacts = await import("../../application/contact-delete");
    ({ leadDeleteDeps: leadDeps, contactDeleteDeps: contactDeps } = await import("@/composition/person-lifecycle"));
    emailStore = (await import("@/contexts/outreach/email/infrastructure/drizzle-outreach-store")).drizzleOutreachStore;
    replyStop = (await import("@/contexts/conversations/after-reply/infrastructure/sequence-stop")).stopPersonOutreachOnReplyTx;
    db = (await import("@/platform/db/client")).db;
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  const settle = <T,>(run: Promise<T>) => run.then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null as T | null, error }));

  /** A regular email campaign with one step and the organization's mailbox ready to claim, in `status`. */
  async function emailCampaign(f: DealsOrg, status: "draft" | "active" | "completed") {
    const id = await f.campaign();
    await kit.sql`update campaigns set status = ${status}, steps = ${kit.sql.json(STEPS as never)} where id = ${id}`;
    await kit.sql`update mailboxes set working_hours = ${kit.sql.json({ timeZone: "UTC", days: ALL_DAY })}, next_send_at = null where organization_id = ${f.org}`;
    return id;
  }

  const mailboxOf = async (f: DealsOrg) => (await kit.sql`select id from mailboxes where organization_id = ${f.org}`)[0].id as string;
  const claim = async (f: DealsOrg) =>
    emailStore.claimNext({ mailboxId: await mailboxOf(f), now: new Date(), pickGapMinutes: () => 0, takeoverAfterHours: () => 24, defaultWorkingHours: () => ({ timeZone: "UTC", days: ALL_DAY as never }) });

  const people = (personId: string) => kit.sql`select id from people where id = ${personId}`.then((rows) => rows.length);
  const sendsOf = (enrollmentId: string) => kit.sql`select status from sends where enrollment_id = ${enrollmentId}`.then((rows) => rows.map((r) => r.status as string));

  /** A gate a port wrapper waits on after its first real call. */
  function gate() {
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => (reached = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    let calls = 0;
    const after = async () => {
      calls += 1;
      if (calls === 1) {
        reached();
        await resumed;
      }
    };
    return { paused, resume, after, calls: () => calls };
  }

  /** Lead deps that stop after the first outreach blocker read, with the batch's people and enrollments locked. */
  function leadPausedAtBlockers() {
    const g = gate();
    const deps: LeadDeleteDeps = {
      ...leadDeps,
      outreach: {
        ...leadDeps.outreach,
        blockers: async (tx, actor, ids) => {
          const found = await leadDeps.outreach.blockers(tx, actor, ids);
          await g.after();
          return found;
        },
      },
    };
    return { ...g, deps };
  }

  /** Lead deps that stop once the batch holds its advisory locks and people rows. */
  function leadPausedAtLock() {
    const g = gate();
    const deps: LeadDeleteDeps = {
      ...leadDeps,
      people: {
        ...leadDeps.people,
        lock: async (tx, org, ids) => {
          const rows = await leadDeps.people.lock(tx, org, ids);
          await g.after();
          return rows;
        },
      },
    };
    return { ...g, deps };
  }

  /** A longer wait than the held-lock timeout once the people rows are held, so the test fixes who waits on whom. */
  const patientLeads: () => LeadDeleteDeps = () => ({
    ...leadDeps,
    people: {
      ...leadDeps.people,
      lock: async (tx, org, ids) => {
        const rows = await leadDeps.people.lock(tx, org, ids);
        await tx.execute(dsql.raw("set local lock_timeout = '10s'"));
        return rows;
      },
    },
  });

  const expectedOf = (preview: ContactDeletePreview) => ({
    deals: preview.counts.deals.won + preview.counts.deals.lost,
    notes: preview.counts.notes,
    tasks: preview.counts.tasks,
    events: preview.counts.events,
    conversations: preview.counts.conversations,
    messages: preview.counts.messages,
    sends: preview.counts.sends,
  });

  /** A contact with an enrollment in `campaignId`. The conversion is SQL, so the enrollment keeps `status`. */
  async function contactEnrolled(f: DealsOrg, campaignId: string, status: string) {
    const personId = await f.person();
    const enrollmentId = await f.enrollment(campaignId, personId, status);
    await kit.sql`update people set lifecycle = 'contact', converted_at = now() where id = ${personId}`;
    return { personId, enrollmentId };
  }

  /** A transaction that does what a send claim does: the enrollment `FOR UPDATE`, then a `sending` send under that lock. */
  const holdClaim = (f: DealsOrg, enrollmentId: string) =>
    holdLocks(TEST_DATABASE_URL ?? "", async (tx) => {
      await tx`select id from campaign_enrollments where id = ${enrollmentId} for update`;
      await tx`insert into sends (organization_id, enrollment_id, step_number, channel, status, attempt, claimed_at) values (${f.org}, ${enrollmentId}, 1, 'email', 'sending', 1, now())`;
    });

  it("lead: a claim while the delete holds the enrollments skips them, and the delete removes the lead with nothing sent", async () => {
    const f = await kit.organization();
    const campaignId = await emailCampaign(f, "draft");
    const lead = await f.person();
    const enrollmentId = await f.enrollment(campaignId, lead, "pending");
    const g = leadPausedAtBlockers();
    const deleting = settle(leads.deleteLeads(g.deps, f.owner, { ids: [lead] }));
    await g.paused;
    // The campaign starts after the delete checked it: the claim would now take the lead, but its enrollment is locked.
    await kit.sql`update campaigns set status = 'active' where id = ${campaignId}`;
    const claimed = await claim(f);
    g.resume();
    const deleted = await deleting;
    expect(claimed).toBeNull();
    expect(deleted.error).toBeNull();
    expect(deleted.value).toEqual({ deleted: 1, blocked: [] });
    expect(await people(lead)).toBe(0);
    expect(await sendsOf(enrollmentId)).toEqual([]);
  }, 30_000);

  it("lead: a claim that holds the enrollment makes the delete wait, and the delete then sees the send and keeps the lead", async () => {
    const f = await kit.organization();
    const campaignId = await emailCampaign(f, "active");
    const lead = await f.person();
    const enrollmentId = await f.enrollment(campaignId, lead, "pending");
    const holder = await holdClaim(f, enrollmentId);
    const deleting = settle(leads.deleteLeads(patientLeads(), f.owner, { ids: [lead] }));
    await waitForLockWaiters(kit.sql, 1);
    await holder.release();
    const deleted = await deleting;
    expect(deleted.error).toBeNull();
    // Without the enrollment lock the delete reads before the claim commits and names the running campaign instead.
    expect(deleted.value?.blocked).toMatchObject([{ id: lead, reason: "has_sends" }]);
    expect(await people(lead)).toBe(1);
    expect(await sendsOf(enrollmentId)).toEqual(["sending"]);
  }, 30_000);

  it("contact: a claim while the delete holds the enrollments skips them, and the delete removes the contact", async () => {
    const f = await kit.organization();
    const campaignId = await emailCampaign(f, "active");
    const { personId, enrollmentId } = await contactEnrolled(f, campaignId, "pending");
    const preview = await contacts.previewContactDelete(contactDeps, f.owner, personId);
    expect(preview.blockers).toEqual([]);
    const g = gate();
    const deps: ContactDeleteDeps = {
      ...contactDeps,
      outreach: {
        ...contactDeps.outreach,
        blockers: async (tx, actor, id, now) => {
          const found = await contactDeps.outreach.blockers(tx, actor, id, now);
          await g.after();
          return found;
        },
      },
    };
    const deleting = settle(contacts.deleteContact(deps, f.owner, personId, { expected: expectedOf(preview) }));
    await g.paused;
    const claimed = await claim(f);
    g.resume();
    const deleted = await deleting;
    expect(claimed).toBeNull();
    expect(deleted.error).toBeNull();
    expect(await people(personId)).toBe(0);
    expect(await sendsOf(enrollmentId)).toEqual([]);
  }, 30_000);

  it("contact: a claim that holds the enrollment makes the delete wait, and the delete then refuses with send_in_flight", async () => {
    const f = await kit.organization();
    const campaignId = await emailCampaign(f, "completed");
    const { personId, enrollmentId } = await contactEnrolled(f, campaignId, "completed");
    const preview = await contacts.previewContactDelete(contactDeps, f.owner, personId);
    const holder = await holdClaim(f, enrollmentId);
    const patient: ContactDeleteDeps = {
      ...contactDeps,
      handling: {
        ...contactDeps.handling,
        lockPersonForDelete: async (tx, org, id) => {
          await contactDeps.handling.lockPersonForDelete(tx, org, id);
          await tx.execute(dsql.raw("set local lock_timeout = '10s'"));
        },
      },
    };
    const deleting = settle(contacts.deleteContact(patient, f.owner, personId, { expected: expectedOf(preview) }));
    await waitForLockWaiters(kit.sql, 1);
    await holder.release();
    const deleted = await deleting;
    expect(sqlState(deleted.error)).toBeNull();
    // The claim also counts as today's send, so `recent_send` comes with it.
    expect((deleted.error as ConflictError).details).toMatchObject({ code: "contact_blocked" });
    expect(((deleted.error as ConflictError).details?.blockers as Array<{ reason: string }>).map((b) => b.reason)).toEqual(["send_in_flight", "recent_send"]);
    expect(await people(personId)).toBe(1);
    expect(await sendsOf(enrollmentId)).toEqual(["sending"]);
  }, 30_000);

  /** Twenty plain leads and one in a running campaign, whose reply stops its enrollment. */
  async function replyWorld(f: DealsOrg) {
    const plain = await Promise.all(Array.from({ length: 20 }, () => f.person()));
    const replier = await f.person();
    const enrollmentId = await f.enrollment(await emailCampaign(f, "active"), replier, "active");
    return { ids: [...plain, replier], plain, replier, enrollmentId };
  }

  const stopOnReply = (f: DealsOrg, personId: string) =>
    db.transaction((tx) => replyStop(tx, { organizationId: f.org, personId, channel: "email", now: new Date() }));

  const enrollmentStatus = async (id: string) => (await kit.sql`select status from campaign_enrollments where id = ${id}`)[0]?.status as string | undefined;

  it("reply stop waits on a bulk delete that holds the advisory locks; both commit", async () => {
    const f = await kit.organization();
    const w = await replyWorld(f);
    const g = leadPausedAtLock();
    const deleting = settle(leads.deleteLeads(g.deps, f.owner, { ids: w.ids }));
    await g.paused;
    const stopping = settle(stopOnReply(f, w.replier));
    await waitForLockWaiters(kit.sql, 1);
    g.resume();
    const [deleted, stopped] = await Promise.all([deleting, stopping]);
    expect(deleted.error).toBeNull();
    expect(stopped.error).toBeNull();
    expect(deleted.value).toMatchObject({ deleted: 20, blocked: [{ id: w.replier, reason: "in_active_campaign" }] });
    expect(stopped.value).toMatchObject({ enrollmentsStopped: 1 });
    expect(await enrollmentStatus(w.enrollmentId)).toBe("replied");
  }, 30_000);

  it("a bulk delete waits on a reply stop that holds the advisory lock, its enrollment and its event; both commit", async () => {
    const f = await kit.organization();
    const w = await replyWorld(f);
    // The reply stop's order: the advisory lock, the enrollment update, then the event insert (key share on the person).
    const holder = await holdLocks(TEST_DATABASE_URL ?? "", async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`person-outreach:${f.org}:${w.replier}`}, 0))`;
      await tx`update campaign_enrollments set status = 'replied', next_send_at = null where id = ${w.enrollmentId}`;
      await tx`insert into events (organization_id, person_id, event_type, actor_type) values (${f.org}, ${w.replier}, 'outreach.stopped_by_reply', 'system')`;
    });
    const deleting = settle(leads.deleteLeads(leadDeps, f.owner, { ids: w.ids }));
    await waitForLockWaiters(kit.sql, 1);
    await holder.release();
    const deleted = await deleting;
    expect(deleted.error).toBeNull();
    expect(deleted.value).toMatchObject({ deleted: 20, blocked: [{ id: w.replier, reason: "linked_records" }] });
  }, 30_000);

  it("unpaused reply stops and bulk deletes over the same people never deadlock", async () => {
    for (let round = 0; round < 8; round++) {
      const f = await kit.organization();
      const w = await replyWorld(f);
      const [deleted, stopped] = await Promise.all([settle(leads.deleteLeads(leadDeps, f.owner, { ids: w.ids })), settle(stopOnReply(f, w.replier))]);
      expect(sqlState(deleted.error)).not.toBe("40P01");
      expect(sqlState(stopped.error)).not.toBe("40P01");
      expect(deleted.error).toBeNull();
      expect(stopped.error).toBeNull();
      expect(deleted.value?.deleted).toBe(20);
      expect(await people(w.replier)).toBe(1);
    }
  }, 60_000);

  it("deletes a lead whose only sends failed, with those sends, and keeps a lead with a sent one", async () => {
    const f = await kit.organization();
    const campaignId = await emailCampaign(f, "completed");
    const failed = await f.person();
    const sent = await f.person();
    const failedEnrollment = await f.enrollment(campaignId, failed, "failed");
    const sentEnrollment = await f.enrollment(campaignId, sent, "completed");
    await kit.sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, attempt) values (${f.org}, ${failedEnrollment}, 1, 'email', 'failed', 3)`;
    await kit.sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, sent_at) values (${f.org}, ${sentEnrollment}, 1, 'email', 'sent', now())`;
    const outcome = await leads.deleteLeads(leadDeps, f.owner, { ids: [failed, sent] });
    expect(outcome).toMatchObject({ deleted: 1, blocked: [{ id: sent, reason: "has_sends" }] });
    expect(await people(failed)).toBe(0);
    expect(await kit.count("sends", f.org, `enrollment_id = '${failedEnrollment}'`)).toBe(0);
    expect(await kit.count("campaign_enrollments", f.org, `person_id = '${failed}'`)).toBe(0);
    expect(await sendsOf(sentEnrollment)).toEqual(["sent"]);
  }, 30_000);

  it("runs a constant number of statements per batch for 10 000 leads", async () => {
    const f = await kit.organization();
    const tag = `bulk${f.tag}`;
    await kit.sql`
      insert into people (organization_id, full_name, email)
      select ${f.org}, ${tag} || ' ' || g, ${tag} || g || '@bulk.test' from generate_series(1, 10000) g`;
    const campaignId = await emailCampaign(f, "completed");
    await kit.sql`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status)
      select ${f.org}, ${campaignId}, id, 'email', 'failed' from people where organization_id = ${f.org} and full_name like ${tag + " 1%"}`;
    await kit.sql`
      insert into sends (organization_id, enrollment_id, step_number, channel, status, attempt)
      select organization_id, id, 1, 'email', 'failed', 3 from campaign_enrollments where campaign_id = ${campaignId}`;

    const statements: number[] = [];
    const counted = <T extends object>(tx: T, count: () => void): T =>
      new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          if (["execute", "select", "selectDistinct", "insert", "update", "delete"].includes(String(prop))) {
            return (...args: unknown[]) => {
              count();
              return value.apply(target, args);
            };
          }
          return value.bind(target);
        },
      });
    const deps: LeadDeleteDeps = {
      ...leadDeps,
      transaction: (fn) =>
        leadDeps.transaction((tx) => {
          statements.push(0);
          const index = statements.length - 1;
          return fn(counted(tx as DbHandle & object, () => (statements[index] += 1)));
        }),
    };
    const outcome = await leads.deleteLeads(deps, f.owner, { filter: { query: tag }, confirmCount: 10000 });
    expect(outcome).toEqual({ deleted: 10000, blocked: [] });
    expect(statements).toHaveLength(20);
    expect(new Set(statements).size).toBe(1);
    expect(statements[0]).toBeLessThanOrEqual(12);
    expect(await kit.count("people", f.org)).toBe(0);
  }, 120_000);
});
