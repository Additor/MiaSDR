import { describe, expect, it, vi } from "vitest";
import { describeDb } from "@/test-support/db";
import { useReplyKit, type ReplyFixture } from "../../../infrastructure/__tests__/replies-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("AI pick apply path: the fixed rule decides the hold, the type's rules the draft and the settle", () => {
  const { sql, modules, fixture, mail, one, count } = useReplyKit();

  const answer = (f: ReplyFixture, key: string, confidence = 0.95) => {
    f.ai!.classifyWith = () => ({ replyTypeKey: key, confidence, reason: "Forced." });
  };
  /**
   * Ingests one reply, applies `prepare` (the organization's reply types exist from the first reply on), and runs the AI
   * tick twice: the pick, then any draft it queued.
   */
  async function pickOn(f: ReplyFixture, bodyText = "Could we book a demo next week?", prepare: () => Promise<unknown> = async () => {}) {
    await modules.composition.ingestInbound(mail(f, { bodyText }));
    await prepare();
    await f.run();
    await f.run();
  }
  const pickRow = (f: ReplyFixture) => one("select status, rules, response, applied_reply_type_id from reply_type_picks where organization_id = $1", [f.org]);
  const conversationRow = (f: ReplyFixture) => one("select workflow_state, group_key, reply_type_id from conversations where organization_id = $1", [f.org]);

  describe("a pick at or above the floor applies at once", () => {
    it("with a draft: the pick applies, snapshots the rules, and the draft keeps the conversation open", async () => {
      const f = await fixture();
      await pickOn(f);
      expect(await pickRow(f)).toMatchObject({ status: "auto_applied", rules: { replyDraft: true, followUps: "continue" } });
      expect(await conversationRow(f)).toMatchObject({ workflow_state: "action_required", group_key: "interested" });
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
    });

    it("with no draft: the pick applies and the conversation settles to idle", async () => {
      const f = await fixture();
      answer(f, "not_required_right_now");
      await pickOn(f, "Not right now, thanks.");
      expect(await pickRow(f)).toMatchObject({ status: "auto_applied", rules: { replyDraft: false, followUps: "stop" } });
      expect(await conversationRow(f)).toMatchObject({ workflow_state: "idle", group_key: "not_interested" });
      expect(await count("drafts", f.org)).toBe(0);
    });

    it("a type that used to wait for a check, such as Other, applies too", async () => {
      const f = await fixture();
      answer(f, "other");
      await pickOn(f, "Who are you?");
      expect(await pickRow(f)).toMatchObject({ status: "auto_applied" });
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
    });
  });

  describe("stop requests", () => {
    it("a stop request in the reply on an Interested type: applies, writes no draft and does not settle", async () => {
      const f = await fixture();
      answer(f, "demo_request");
      await pickOn(f, "A demo could be nice, but please stop emailing me.");
      const pick = await pickRow(f);
      expect(pick).toMatchObject({ status: "auto_applied" });
      expect(pick.response).toMatchObject({ stopRequested: true, holdReason: null });
      expect(await conversationRow(f)).toMatchObject({ workflow_state: "action_required", group_key: "interested" });
      expect(await count("drafts", f.org)).toBe(0);
      expect(await count("contact_policies", f.org, "do_not_contact")).toBe(0);
    });

    it("an Asked to stop pick is held for a person, flagged as a stop request by its role, and marks nothing", async () => {
      const f = await fixture();
      answer(f, "do_not_contact", 0.99);
      // No stop words in the reply: the flag comes from the type's system role.
      await pickOn(f, "Thanks, that is all from me.");
      const pick = await pickRow(f);
      expect(pick).toMatchObject({ status: "proposed", rules: { replyDraft: false, followUps: "stop" } });
      expect(pick.response).toMatchObject({ holdReason: "stop_request", stopRequested: true });
      expect(await conversationRow(f)).toMatchObject({ workflow_state: "action_required", group_key: null });
      expect(await count("drafts", f.org)).toBe(0);
      expect(await count("contact_policies", f.org, "do_not_contact")).toBe(0);
    });

    it("a person's later picks of the same reply keep the stop request: no draft, and the outcomes say why", async () => {
      const f = await fixture();
      answer(f, "do_not_contact", 0.99);
      await pickOn(f, "Thanks, that is all from me.");
      expect((await pickRow(f)).response).toMatchObject({ stopRequested: true });
      const handling = await import("../../../application/reply-handling");
      const deps = (await import("../../../infrastructure/reply-handling-composition")).replyHandlingDeps();
      const conversation = await one("select id, context_version from conversations where organization_id = $1", [f.org]);
      const other = await one("select id from reply_types where organization_id = $1 and key = 'other'", [f.org]);
      // Off the thread first: the held AI pick stays at the old version, so the person's pick below is a new row.
      await handling.changeReplyType(deps, f.actor, conversation.id, { groupKey: "other", replyTypeId: other.id, expectedContextVersion: conversation.context_version });
      const conv = await one("select c.id, r.context_version from threads c join conversations r on r.id = c.conversation_id where c.organization_id = $1", [f.org]);
      const first = await modules.stores.replies.applyHumanReplyTypePick({ organizationId: f.org, threadId: conv.id, replyTypeKey: "demo_request", expectedContextVersion: conv.context_version, actorUserId: f.user });
      expect(first.draftQueued).toBe(false);
      const again = await one("select r.context_version from conversations r where r.organization_id = $1", [f.org]);
      const second = await modules.stores.replies.applyHumanReplyTypePick({ organizationId: f.org, threadId: conv.id, replyTypeKey: "meeting_requested", expectedContextVersion: again.context_version, actorUserId: f.user });
      expect(second.draftQueued).toBe(false);
      const outcomes = await handling.getTypeChangeOutcomes(deps, f.actor, conversation.id, "correct");
      const demo = await one("select id from reply_types where organization_id = $1 and key = 'demo_request'", [f.org]);
      expect(outcomes.find((o) => o.replyTypeId === demo.id)?.outcome.replyDraft).toBe("Reply draft: none, because they asked to stop.");
    });

    it("a stop request type under another name is still read by its role", async () => {
      const f = await fixture();
      answer(f, "do_not_contact", 0.99);
      await pickOn(f, "Thanks.", () => sql`update reply_types set name = 'Leave me alone' where organization_id = ${f.org} and system_role = 'stop_request'`);
      expect((await pickRow(f)).response).toMatchObject({ holdReason: "stop_request", stopRequested: true });
    });
  });

  describe("fixed holds", () => {
    it("holds a pick below the confidence floor", async () => {
      const f = await fixture();
      answer(f, "demo_request", 0.5);
      await pickOn(f);
      const pick = await pickRow(f);
      expect(pick).toMatchObject({ status: "proposed", rules: { replyDraft: true } });
      expect(pick.response).toMatchObject({ holdReason: "low_confidence" });
      expect(await count("drafts", f.org)).toBe(0);
    });

    it("holds a pick that would move a locked customer out of its group", async () => {
      const f = await fixture();
      answer(f, "demo_request", 0.99);
      await modules.composition.ingestInbound(mail(f));
      const [customer] = await sql`select id from reply_types where organization_id = ${f.org} and system_role = 'customer'`;
      await sql`update conversations set group_key = 'customer', reply_type_id = ${customer.id}, reply_type_source = 'human', reply_type_locked = true where organization_id = ${f.org}`;
      await f.run();
      const pick = await pickRow(f);
      expect(pick).toMatchObject({ status: "proposed" });
      expect(pick.response).toMatchObject({ holdReason: "protected_customer" });
      expect(await conversationRow(f)).toMatchObject({ group_key: "customer", reply_type_id: customer.id });
      expect(await count("drafts", f.org)).toBe(0);
    });
  });

  describe("one decision under the conversation lock", () => {
    it("a lock set after the job read its context holds the pick, with no draft and no settle", async () => {
      const f = await fixture();
      answer(f, "demo_request", 0.9);
      const jobs = modules.stores.jobs;
      const load = jobs.loadClassifyContext.bind(jobs);
      const spy = vi.spyOn(jobs, "loadClassifyContext").mockImplementation(async (org, messageId) => {
        const ctx = await load(org, messageId);
        const [customer] = await sql`select id from reply_types where organization_id = ${f.org} and system_role = 'customer'`;
        await sql`update conversations set group_key = 'customer', reply_type_id = ${customer.id}, reply_type_source = 'human', reply_type_locked = true where organization_id = ${f.org}`;
        return ctx;
      });
      try {
        await pickOn(f);
      } finally {
        spy.mockRestore();
      }
      const pick = await pickRow(f);
      expect(pick).toMatchObject({ status: "proposed", applied_reply_type_id: null });
      expect(pick.response).toMatchObject({ holdReason: "protected_customer" });
      expect(await conversationRow(f)).toMatchObject({ workflow_state: "action_required", group_key: "customer" });
      expect(await count("drafts", f.org)).toBe(0);
      expect(await one("select event_type from events where organization_id = $1 and event_type like 'reply_type_pick.%'", [f.org])).toMatchObject({ event_type: "reply_type_pick.proposed" });
    });
  });

  describe("the customer lock on a person's pick, undo and detach", () => {
    /** The conversation locked on `typeId` of the customer group, as a person's type change leaves it. */
    const lockOn = (f: ReplyFixture, typeId: string) =>
      sql`update conversations set group_key = 'customer', reply_type_id = ${typeId}, reply_type_source = 'human', reply_type_locked = true where organization_id = ${f.org}`;
    const customerType = async (f: ReplyFixture) => (await sql`select id from reply_types where organization_id = ${f.org} and system_role = 'customer'`)[0].id as string;
    /** A second type in the customer group, without a role. */
    const renewalType = async (f: ReplyFixture) =>
      (await sql`insert into reply_types (organization_id, reply_type_set_id, group_key, key, name, sort_order)
                 select organization_id, reply_type_set_id, 'customer', 'renewal', 'Renewal', 99 from reply_types where organization_id = ${f.org} and system_role = 'customer' returning id`)[0].id as string;
    const pickRequest = async (f: ReplyFixture, replyTypeKey: string | null) => {
      const [conv] = await sql`select c.id, r.context_version from threads c join conversations r on r.id = c.conversation_id where c.organization_id = ${f.org}`;
      return modules.stores.replies.applyHumanReplyTypePick({ organizationId: f.org, threadId: conv.id, replyTypeKey, expectedContextVersion: conv.context_version, actorUserId: f.user });
    };
    const handling = async () => (await import("../../../infrastructure/drizzle-reply-handling-store")).drizzleReplyHandlingStore;
    const lockRow = (f: ReplyFixture) => one("select group_key, reply_type_id, reply_type_locked from conversations where organization_id = $1", [f.org]);

    it("accepting a protected_customer hold moves the locked customer out and unlocks", async () => {
      const f = await fixture();
      answer(f, "demo_request", 0.99);
      await modules.composition.ingestInbound(mail(f));
      await lockOn(f, await customerType(f));
      await f.run();
      expect((await pickRow(f)).response).toMatchObject({ holdReason: "protected_customer" });
      await pickRequest(f, null);
      expect(await lockRow(f)).toMatchObject({ group_key: "interested", reply_type_locked: false });
    });

    it("a person's pick of a type outside the customer group unlocks, and the customer role type locks", async () => {
      const f = await fixture();
      answer(f, "demo_request", 0.99);
      await modules.composition.ingestInbound(mail(f));
      await lockOn(f, await customerType(f));
      await f.run();
      await pickRequest(f, "meeting_requested");
      expect(await lockRow(f)).toMatchObject({ group_key: "interested", reply_type_locked: false });
      await pickRequest(f, "customer");
      expect(await lockRow(f)).toMatchObject({ group_key: "customer", reply_type_locked: true });
    });

    it("a person's pick of any type of the customer group locks, and a move out unlocks", async () => {
      const f = await fixture();
      answer(f, "demo_request", 0.99);
      await modules.composition.ingestInbound(mail(f));
      const renewal = await renewalType(f);
      await f.run();
      await pickRequest(f, "renewal");
      expect(await lockRow(f)).toMatchObject({ group_key: "customer", reply_type_id: renewal, reply_type_locked: true });
      await pickRequest(f, "meeting_requested");
      expect(await lockRow(f)).toMatchObject({ group_key: "interested", reply_type_locked: false });
    });

    it("undo of a pick stored without its earlier lock falls back to the previous group", async () => {
      const f = await fixture();
      answer(f, "customer", 0.99);
      await modules.composition.ingestInbound(mail(f));
      const renewal = await renewalType(f);
      await lockOn(f, renewal);
      await f.run();
      // A pick from before `previousLocked` existed: only its previous group tells the lock.
      const pick = await one("select id, status from reply_type_picks where organization_id = $1", [f.org]);
      expect(pick.status).toBe("auto_applied");
      await sql`update reply_type_picks set response = response - 'previousLocked' where id = ${pick.id}`;
      await (await handling()).undoReplyTypePick({ organizationId: f.org, replyTypePickId: pick.id, actorUserId: f.user, now: new Date() });
      expect(await lockRow(f)).toMatchObject({ group_key: "customer", reply_type_id: renewal, reply_type_locked: true });
    });

    it("undo restores the lock the conversation had before the pick, on any type of the customer group", async () => {
      const f = await fixture();
      answer(f, "customer", 0.99);
      await modules.composition.ingestInbound(mail(f));
      const renewal = await renewalType(f);
      await lockOn(f, renewal);
      await f.run();
      const pick = await one("select id, status from reply_type_picks where organization_id = $1", [f.org]);
      expect(pick.status).toBe("auto_applied");
      await (await handling()).undoReplyTypePick({ organizationId: f.org, replyTypePickId: pick.id, actorUserId: f.user, now: new Date() });
      expect(await lockRow(f)).toMatchObject({ group_key: "customer", reply_type_id: renewal, reply_type_locked: true });
    });

    it("undo of a person's pick that moved a locked customer out locks them again", async () => {
      const f = await fixture();
      answer(f, "demo_request", 0.99);
      await modules.composition.ingestInbound(mail(f));
      const renewal = await renewalType(f);
      await lockOn(f, renewal);
      await f.run();
      await pickRequest(f, null);
      const pick = await one("select id from reply_type_picks where organization_id = $1", [f.org]);
      await (await handling()).undoReplyTypePick({ organizationId: f.org, replyTypePickId: pick.id, actorUserId: f.user, now: new Date() });
      expect(await lockRow(f)).toMatchObject({ group_key: "customer", reply_type_id: renewal, reply_type_locked: true });
    });
  });
});
