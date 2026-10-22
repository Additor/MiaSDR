import { sql as drizzleSql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, type TestOrg, testSql, useTestEnv, waitForLockWaiters } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

const NOW = new Date("2026-10-14T10:00:00Z");
const LI_STEPS = [
  { stepNumber: 1, kind: "invitation", body: "Hi", waitDays: 0 },
  { stepNumber: 2, kind: "message", body: "Follow up", waitDays: 2 },
];
const MAIL_STEPS = [
  { stepNumber: 1, subject: "a", body: "b", waitDays: 0 },
  { stepNumber: 2, subject: "c", body: "d", waitDays: 3 },
];

describeDb("restore of removed enrollments", () => {
  useTestEnv();
  const sql = testSql({ max: 4 });
  let uc: typeof import("../../application/enrollment-restore");
  let admin: typeof import("../drizzle-enrollment-admin").drizzleEnrollmentAdminStore;
  let restoreDeps: import("../../application/enrollment-restore").EnrollmentRestoreDeps;
  const orgs: TestOrg[] = [];

  async function fixture(channel: "linkedin" | "email" = "linkedin") {
    const tag = Math.random().toString(36).slice(2, 8);
    const created = await createTestOrg(sql, "R", "member");
    orgs.push(created);
    const { organizationId: org, userId } = created;
    const campaign = async (name: string, over: { status?: string; channel?: string; archived?: boolean } = {}) => {
      const ch = over.channel ?? channel;
      const [{ id }] = await sql`
        insert into campaigns (organization_id, channel, name, status, steps, archived_at)
        values (${org}, ${ch}, ${name}, ${over.status ?? "active"}, ${sql.json((ch === "linkedin" ? LI_STEPS : MAIL_STEPS) as never)}, ${over.archived ? NOW : null}) returning id`;
      return id as string;
    };
    const person = async (name: string, email?: string) => {
      const slug = `${name.toLowerCase().replace(/\W+/g, "-")}-${tag}`;
      const [first, ...rest] = name.split(" ");
      const [{ id }] = await sql`
        insert into people (organization_id, first_name, last_name, full_name, email, linkedin_slug)
        values (${org}, ${first}, ${rest.join(" ") || null}, ${name}, ${email ?? `${slug}@lead.test`}, ${slug}) returning id`;
      return id as string;
    };
    const enroll = async (campaignId: string, personId: string, over: { status?: string; step?: number; connection?: string; ch?: string } = {}) => {
      const ch = over.ch ?? channel;
      const [{ id }] = await sql`
        insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, stop_reason)
        values (${org}, ${campaignId}, ${personId}, ${ch}, ${over.status ?? "removed"}, ${over.step ?? 0}, ${over.status === undefined || over.status === "removed" ? "removed" : null}) returning id`;
      if (ch === "linkedin") await sql`insert into linkedin_enrollment_details (enrollment_id, organization_id, profile_url, connection_state) values (${id}, ${org}, 'https://www.linkedin.com/in/x', ${over.connection ?? "none"})`;
      return id as string;
    };
    const actor: Actor = { userId, organizationId: org, role: "member" };
    return { org, tag, campaign, person, enroll, actor };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const row = async (id: string) => (await sql`select status, current_step, next_send_at, stop_reason from campaign_enrollments where id = ${id}`)[0];
  const trail = async (org: string) => ({
    events: await sql`select event_type, actor_type, actor_user_id, person_id, from_data, to_data from events where organization_id = ${org} and event_type = 'enrollment.restored' order by created_at`,
    audit: await sql`select action, actor_user_id, entity_type, entity_id, meta from audit_log where organization_id = ${org} and action = 'enrollment.restored' order by created_at`,
  });
  const restore = (f: Fixture, campaignId: string, ids: string[], channel: "linkedin" | "email" = "linkedin") =>
    uc.restoreCampaignEnrollments({ ...restoreDeps, now: () => NOW }, f.actor, channel, campaignId, ids);

  beforeAll(async () => {
    uc = await import("../../application/enrollment-restore");
    ({ drizzleEnrollmentAdminStore: admin } = await import("../drizzle-enrollment-admin"));
    const { enrollmentRestoreDeps } = await import("../restore-composition");
    restoreDeps = enrollmentRestoreDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("restores a removed lead that never sent to pending, clears the reason, and writes the event and the audit row", async () => {
    const f = await fixture();
    const c = await f.campaign("Main");
    const p = await f.person("Ada Lovelace");
    const e = await f.enroll(c, p);

    const out = await restore(f, c, [e]);
    expect(out).toEqual({ requested: 1, restored: 1, refused: [], notFound: 0 });
    expect(await row(e)).toMatchObject({ status: "pending", current_step: 0, next_send_at: null, stop_reason: null });

    const { events, audit } = await trail(f.org);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_type: "human", actor_user_id: f.actor.userId, person_id: p, from_data: { status: "removed" }, to_data: { status: "pending", campaignId: c, enrollmentId: e } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: f.actor.userId, entity_type: "campaign_enrollment", entity_id: e, meta: { campaignId: c, channel: "linkedin", personId: p, status: "pending" } });
  });

  it("removes and restores in a cycle through the real remove store", async () => {
    const f = await fixture();
    const c = await f.campaign("Main");
    const p = await f.person("Cycle Person");
    const e = await f.enroll(c, p, { status: "pending" });
    expect(await admin.removeEnrollments(f.org, c, "linkedin", [e], NOW)).toMatchObject({ removed: 1 });
    expect((await row(e)).status).toBe("removed");
    expect(await restore(f, c, [e])).toMatchObject({ restored: 1 });
    expect(await row(e)).toMatchObject({ status: "pending", stop_reason: null });
  });

  it("returns progress to active: waiting invitation without a due time, accepted lead due now", async () => {
    const f = await fixture();
    const c = await f.campaign("Main");
    const waiting = await f.enroll(c, await f.person("Waiting Person"), { step: 1, connection: "request_sent" });
    const accepted = await f.enroll(c, await f.person("Accepted Person"), { step: 1, connection: "connected" });
    const out = await restore(f, c, [waiting, accepted]);
    expect(out.restored).toBe(2);
    expect(await row(waiting)).toMatchObject({ status: "active", current_step: 1, next_send_at: null });
    expect(await row(accepted)).toMatchObject({ status: "active", current_step: 1, next_send_at: NOW });
  });

  it("restores an email lead with a follow-up left as active and due now", async () => {
    const f = await fixture("email");
    const c = await f.campaign("Mail");
    const never = await f.enroll(c, await f.person("Never Sent"));
    const mid = await f.enroll(c, await f.person("Mid Sequence"), { step: 1 });
    const out = await restore(f, c, [never, mid], "email");
    expect(out.restored).toBe(2);
    expect(await row(never)).toMatchObject({ status: "pending", next_send_at: null });
    expect(await row(mid)).toMatchObject({ status: "active", next_send_at: NOW });
  });

  describe("refusals leave the lead removed and write nothing", () => {
    async function refuses(f: Fixture, campaignId: string, enrollmentId: string, reason: string, channel: "linkedin" | "email" = "linkedin") {
      const out = await restore(f, campaignId, [enrollmentId], channel);
      expect(out.restored).toBe(0);
      expect(out.refused).toHaveLength(1);
      expect(out.refused[0]).toMatchObject({ enrollmentId, reason });
      expect(out.refused[0].message).not.toBe("");
      expect(await row(enrollmentId)).toMatchObject({ status: "removed", stop_reason: "removed" });
      const { events, audit } = await trail(f.org);
      expect(events).toHaveLength(0);
      expect(audit).toHaveLength(0);
      return out;
    }

    it("a person who replied to the campaign mail or LinkedIn message", async () => {
      const f = await fixture();
      const c = await f.campaign("Main");
      const p = await f.person("Replied Person");
      const e = await f.enroll(c, p);
      // The reply arrived after the lead was removed: only the message shows it.
      const [{ id: pipeline }] = await sql`select id from pipelines where organization_id = ${f.org} limit 1`.then((r) => (r.length ? r : sql`insert into pipelines (organization_id, name) values (${f.org}, 'P') returning id`));
      const [{ id: record }] = await sql`insert into records (organization_id, person_id, pipeline_id) values (${f.org}, ${p}, ${pipeline}) returning id`;
      const [{ id: conversation }] = await sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${f.org}, ${record}, 'linkedin', 'acct') returning id`;
      await sql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at) values (${f.org}, ${conversation}, 'linkedin', 'acct', 'inbound', 'm1', 'Thanks, not now', now())`;
      await refuses(f, c, e, "replied");
    });

    it("ignores an automatic reply", async () => {
      const f = await fixture("email");
      const c = await f.campaign("Mail");
      const p = await f.person("Away Person");
      const e = await f.enroll(c, p);
      const [{ id: pipeline }] = await sql`insert into pipelines (organization_id, name) values (${f.org}, 'P') returning id`;
      const [{ id: record }] = await sql`insert into records (organization_id, person_id, pipeline_id) values (${f.org}, ${p}, ${pipeline}) returning id`;
      const [{ id: conversation }] = await sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${f.org}, ${record}, 'email', 'me@x.test') returning id`;
      await sql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, raw, sent_at) values (${f.org}, ${conversation}, 'email', 'me@x.test', 'inbound', 'm1', 'Out of office', ${sql.json({ autoReply: true } as never)}, now())`;
      expect(await restore(f, c, [e], "email")).toMatchObject({ restored: 1 });
    });

    it("a person whose enrollment in another campaign ended as replied", async () => {
      const f = await fixture();
      const [a, b] = [await f.campaign("A"), await f.campaign("B")];
      const p = await f.person("Elsewhere Replied");
      const e = await f.enroll(a, p);
      await f.enroll(b, p, { status: "replied" });
      await refuses(f, a, e, "replied");
    });

    it("do not contact", async () => {
      const f = await fixture();
      const c = await f.campaign("Main");
      const p = await f.person("Blocked Person");
      const e = await f.enroll(c, p);
      await sql`insert into contact_policies (organization_id, person_id, do_not_contact, source, set_at) values (${f.org}, ${p}, true, 'human', now())`;
      await refuses(f, c, e, "do_not_contact");
    });

    it("a contact, on either channel, and the enrollment stays removed", async () => {
      for (const channel of ["linkedin", "email"] as const) {
        const f = await fixture(channel);
        const c = await f.campaign("Main");
        const p = await f.person("Converted Person");
        const e = await f.enroll(c, p);
        await sql`update people set lifecycle = 'contact', converted_at = now() where id = ${p}`;
        const out = await restore(f, c, [e], channel);
        expect(out).toMatchObject({ restored: 0, refused: [{ enrollmentId: e, reason: "contact", message: "The person is a contact, so no campaign enrolls them." }] });
        expect(await row(e)).toMatchObject({ status: "removed", stop_reason: "removed" });
      }
    });

    it("a suppressed address on an email campaign, and not on LinkedIn", async () => {
      const mail = await fixture("email");
      const mc = await mail.campaign("Mail");
      const p = await mail.person("Unsubscribed Person", "gone@unsub.test");
      const e = await mail.enroll(mc, p);
      await sql`insert into suppression_list (organization_id, email, reason) values (${mail.org}, 'gone@unsub.test', 'unsubscribed')`;
      await refuses(mail, mc, e, "suppressed", "email");

      const li = await fixture();
      const lc = await li.campaign("LI");
      const q = await li.person("Linked Person", "gone2@unsub.test");
      const le = await li.enroll(lc, q);
      await sql`insert into suppression_list (organization_id, email, reason) values (${li.org}, 'gone2@unsub.test', 'unsubscribed')`;
      expect(await restore(li, lc, [le])).toMatchObject({ restored: 1 });
    });

    it("a person who is pending or active in another campaign on the channel, named in the answer", async () => {
      const f = await fixture();
      const [a, b] = [await f.campaign("A"), await f.campaign("Other wave")];
      const p = await f.person("Busy Person");
      const e = await f.enroll(a, p);
      await f.enroll(b, p, { status: "active", step: 1, connection: "request_sent" });
      const out = await refuses(f, a, e, "active_elsewhere");
      expect(out.refused[0].detail).toBe("Other wave");
    });

    it("allows a person who is only active on the other channel", async () => {
      const f = await fixture();
      const a = await f.campaign("A");
      const mail = await f.campaign("Mail", { channel: "email" });
      const p = await f.person("Two Channels");
      const e = await f.enroll(a, p);
      await f.enroll(mail, p, { status: "active", step: 1, ch: "email" });
      expect(await restore(f, a, [e])).toMatchObject({ restored: 1 });
    });

    it("a completed or archived campaign", async () => {
      const f = await fixture();
      const done = await f.campaign("Done", { status: "completed" });
      const archived = await f.campaign("Archived", { status: "completed", archived: true });
      await refuses(f, done, await f.enroll(done, await f.person("In Done")), "campaign_closed");
      await refuses(f, archived, await f.enroll(archived, await f.person("In Archived")), "campaign_closed");
    });

    it("a lead whose steps all went out", async () => {
      const f = await fixture();
      const c = await f.campaign("Main");
      await refuses(f, c, await f.enroll(c, await f.person("All Sent"), { step: 2, connection: "connected" }), "nothing_left");
    });

    it("a lead that is not removed keeps its status", async () => {
      const f = await fixture();
      const c = await f.campaign("Main");
      const statuses = ["pending", "active", "replied", "completed", "bounced", "suppressed", "failed", "cancelled"];
      const ids: string[] = [];
      for (const status of statuses) ids.push(await f.enroll(c, await f.person(`Status ${status}`), { status, step: status === "active" ? 1 : 0, connection: "request_sent" }));
      const out = await restore(f, c, ids);
      expect(out.restored).toBe(0);
      expect(out.refused.map((r) => r.reason)).toEqual(Array(statuses.length).fill("not_removed"));
      for (const [i, status] of statuses.entries()) expect((await row(ids[i])).status).toBe(status);
      expect((await trail(f.org)).audit).toHaveLength(0);
    });
  });

  it("restores the eligible leads of a mixed call and reports the rest", async () => {
    const f = await fixture();
    const c = await f.campaign("Main");
    const ok = await f.enroll(c, await f.person("Fine Person"));
    const dncPerson = await f.person("Blocked Mixed");
    const blocked = await f.enroll(c, dncPerson);
    await sql`insert into contact_policies (organization_id, person_id, do_not_contact, source, set_at) values (${f.org}, ${dncPerson}, true, 'human', now())`;
    const out = await restore(f, c, [ok, blocked, "00000000-0000-4000-8000-000000000001"]);
    expect(out).toMatchObject({ requested: 3, restored: 1, notFound: 1 });
    expect(out.refused.map((r) => [r.enrollmentId, r.reason, r.personName])).toEqual([[blocked, "do_not_contact", "Blocked Mixed"]]);
    expect((await row(ok)).status).toBe("pending");
    expect((await row(blocked)).status).toBe("removed");
    expect((await trail(f.org)).audit).toHaveLength(1);
  });

  it("is repeatable: a second call refuses with not_removed and writes nothing more", async () => {
    const f = await fixture();
    const c = await f.campaign("Main");
    const e = await f.enroll(c, await f.person("Twice Person"));
    await restore(f, c, [e]);
    const again = await restore(f, c, [e]);
    expect(again).toMatchObject({ restored: 0, refused: [{ reason: "not_removed" }] });
    expect((await trail(f.org)).audit).toHaveLength(1);
    expect((await trail(f.org)).events).toHaveLength(1);
  });

  it("treats a foreign campaign, a foreign lead and a wrong channel as not found", async () => {
    const f = await fixture();
    const g = await fixture();
    const mine = await f.campaign("Mine");
    const theirs = await g.campaign("Theirs");
    const foreign = await g.enroll(theirs, await g.person("Foreign Person"));
    const other = await f.campaign("Other");
    const inOther = await f.enroll(other, await f.person("In Other"));

    await expect(restore(f, theirs, [foreign])).rejects.toBeInstanceOf(NotFoundError);
    expect(await restore(f, mine, [foreign, inOther])).toMatchObject({ restored: 0, refused: [], notFound: 2 });
    await expect(restore(f, mine, [inOther], "email")).rejects.toBeInstanceOf(NotFoundError);
    expect((await row(foreign)).status).toBe("removed");
    expect((await row(inOther)).status).toBe("removed");
  });

  it("validates the id list", async () => {
    const f = await fixture();
    const c = await f.campaign("Main");
    await expect(restore(f, c, [])).rejects.toBeInstanceOf(ValidationError);
    await expect(restore(f, c, Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`))).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps the remove rule: removal still changes only pending and active rows", async () => {
    const f = await fixture();
    const c = await f.campaign("Main");
    const statuses = ["pending", "active", "replied", "completed", "bounced", "suppressed", "failed", "cancelled"];
    const ids: string[] = [];
    for (const status of statuses) ids.push(await f.enroll(c, await f.person(`Rm ${status}`), { status }));
    const out = await admin.removeEnrollments(f.org, c, "linkedin", ids, NOW);
    expect(out).toMatchObject({ removed: 2, skippedFinal: 6 });
    const after = await Promise.all(ids.map(async (id) => (await row(id)).status));
    expect(after).toEqual(["removed", "removed", "replied", "completed", "bounced", "suppressed", "failed", "cancelled"]);
  });

  describe("concurrency", () => {
    /** Holds the person's outreach lock, the one a reply stop or another restore takes, until released. */
    async function holdLock(org: string, personId: string) {
      const { db } = await import("@/platform/db/client");
      const { lockPersonOutreachTx } = await import("@/platform/db/person-locks");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const hasLock = new Promise<void>((resolve) => (locked = resolve));
      const held = db.transaction(async (tx) => {
        await lockPersonOutreachTx(tx, org, [personId]);
        locked();
        await gate;
      });
      await hasLock;
      return { release, done: held };
    }

    it("lets two concurrent restores of one person end with at most one pending or active enrollment", async () => {
      const f = await fixture();
      const x = await f.campaign("X");
      const y = await f.campaign("Y");
      const p = await f.person("Twice Removed");
      const ex = await f.enroll(x, p);
      const ey = await f.enroll(y, p);
      const hold = await holdLock(f.org, p);
      let settled = 0;
      const track = <T,>(promise: Promise<T>) => promise.finally(() => (settled += 1));
      const both = Promise.all([track(restore(f, x, [ex])), track(restore(f, y, [ey]))]);
      await waitForLockWaiters(sql, 2);
      expect(settled, "both restores wait for the person's lock").toBe(0);
      hold.release();
      await hold.done;
      const [rx, ry] = await both;
      expect(rx.restored + ry.restored).toBe(1);
      const live = [await row(ex), await row(ey)].filter((r) => r.status === "pending" || r.status === "active");
      expect(live).toHaveLength(1);
      const refused = [...rx.refused, ...ry.refused];
      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toBe("active_elsewhere");
    });

    it("never leaves the person active after a reply that committed first", async () => {
      const f = await fixture();
      const x = await f.campaign("X");
      const p = await f.person("Replier");
      const ex = await f.enroll(x, p);
      const { db } = await import("@/platform/db/client");
      const { stopPersonOutreachOnReplyTx } = await import("@/contexts/conversations/after-reply/infrastructure/sequence-stop");
      let proceed!: () => void;
      const gate = new Promise<void>((resolve) => (proceed = resolve));
      let stopped!: () => void;
      const stopRan = new Promise<void>((resolve) => (stopped = resolve));
      // The reply transaction stores the message, stops the outreach and has not committed yet.
      const reply = db.transaction(async (tx) => {
        const [{ id: pipeline }] = await tx.execute(drizzleSql`insert into pipelines (organization_id, name, is_default) values (${f.org}, 'p', true) returning id`) as unknown as Array<{ id: string }>;
        const [{ id: record }] = (await tx.execute(drizzleSql`insert into records (organization_id, person_id, pipeline_id) values (${f.org}, ${p}, ${pipeline}) returning id`)) as unknown as Array<{ id: string }>;
        const [{ id: conversation }] = (await tx.execute(drizzleSql`insert into conversations (organization_id, record_id, channel, account_ref, provider_thread_id) values (${f.org}, ${record}, 'linkedin', 'acct', 'chat') returning id`)) as unknown as Array<{ id: string }>;
        await tx.execute(drizzleSql`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, from_address, to_address, body_text, sent_at)
                             values (${f.org}, ${conversation}, 'linkedin', 'acct', 'inbound', 'k-reply', 'p', 'me', 'Hello', now())`);
        await stopPersonOutreachOnReplyTx(tx, { organizationId: f.org, personId: p, channel: "linkedin", now: NOW });
        stopped();
        await gate;
      });
      await stopRan;
      let settled = false;
      const restoring = restore(f, x, [ex]).finally(() => (settled = true));
      await waitForLockWaiters(sql, 1);
      expect(settled, "the restore waits for the reply to commit").toBe(false);
      proceed();
      await reply;
      const out = await restoring;
      expect(out.restored).toBe(0);
      expect(out.refused.map((r) => r.reason)).toEqual(["replied"]);
      expect((await row(ex)).status).toBe("removed");
    });
  });

  describe("progress that completed while the lead was removed", () => {
    const insertSend = (org: string, enrollment: string, step: number, status: string, at: Date, account?: string) =>
      sql`insert into sends (organization_id, enrollment_id, step_number, channel, status, sent_at, claimed_at)
          values (${org}, ${enrollment}, ${step}, ${account ?? "linkedin"}, ${status}, ${status === "sent" ? at : null}, ${at})`;

    it("restores a LinkedIn lead removed during an in-flight invitation as active at step 1", async () => {
      const f = await fixture();
      const c = await f.campaign("Main");
      const e = await f.enroll(c, await f.person("In Flight"), { step: 0, connection: "request_sent" });
      await insertSend(f.org, e, 1, "sent", new Date(NOW.getTime() - 60 * 60_000));
      expect(await restore(f, c, [e])).toMatchObject({ restored: 1 });
      expect(await row(e)).toMatchObject({ status: "active", current_step: 1, next_send_at: null });
    });

    it("writes the connection state back when the invitation went out and the details never moved", async () => {
      const f = await fixture();
      const c = await f.campaign("Main");
      const e = await f.enroll(c, await f.person("Details Behind"), { step: 0, connection: "none" });
      await insertSend(f.org, e, 1, "sent", new Date(NOW.getTime() - 60 * 60_000));
      expect(await restore(f, c, [e])).toMatchObject({ restored: 1 });
      expect(await row(e)).toMatchObject({ status: "active", current_step: 1 });
      expect((await sql`select connection_state from linkedin_enrollment_details where enrollment_id = ${e}`)[0].connection_state).toBe("request_sent");
    });

    it("counts an unconfirmed send as done, so the claim never sends the step twice", async () => {
      const f = await fixture();
      const c = await f.campaign("Main");
      const e = await f.enroll(c, await f.person("Unknown Outcome"), { step: 0, connection: "request_sent" });
      await insertSend(f.org, e, 1, "unknown", new Date(NOW.getTime() - 60 * 60_000));
      expect(await restore(f, c, [e])).toMatchObject({ restored: 1 });
      expect(await row(e)).toMatchObject({ status: "active", current_step: 1 });
    });

    it("waits the next step's days after the last send for an email lead removed in flight", async () => {
      const f = await fixture("email");
      const c = await f.campaign("Mail");
      const e = await f.enroll(c, await f.person("Mail In Flight"), { step: 0 });
      const sentAt = new Date(NOW.getTime() - 10 * 60_000);
      await insertSend(f.org, e, 1, "sent", sentAt, "email");
      expect(await restore(f, c, [e], "email")).toMatchObject({ restored: 1 });
      const after = await row(e);
      expect(after).toMatchObject({ status: "active", current_step: 1 });
      expect(new Date(after.next_send_at).getTime()).toBe(sentAt.getTime() + 3 * 86_400_000);
    });

    it("does not send step 2 at once when the lead was removed ten minutes after accepting and step 2 waits days", async () => {
      const f = await fixture();
      const c = await f.campaign("Main");
      const e = await f.enroll(c, await f.person("Just Accepted"), { step: 1, connection: "connected" });
      const acceptedAt = new Date(NOW.getTime() - 10 * 60_000);
      await sql`update linkedin_enrollment_details set accepted_at = ${acceptedAt} where enrollment_id = ${e}`;
      expect(await restore(f, c, [e])).toMatchObject({ restored: 1 });
      expect(new Date((await row(e)).next_send_at).getTime()).toBe(acceptedAt.getTime() + 2 * 86_400_000);
    });

    it("sends right away when the wait already passed", async () => {
      const f = await fixture();
      const c = await f.campaign("Main");
      const e = await f.enroll(c, await f.person("Long Ago"), { step: 1, connection: "connected" });
      await sql`update linkedin_enrollment_details set accepted_at = ${new Date(NOW.getTime() - 5 * 86_400_000)} where enrollment_id = ${e}`;
      expect(await restore(f, c, [e])).toMatchObject({ restored: 1 });
      expect(new Date((await row(e)).next_send_at).getTime()).toBe(NOW.getTime());
    });
  });
});
