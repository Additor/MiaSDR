import { describe, expect, it } from "vitest";
import { describeDb } from "@/test-support/db";
import { useReplyKit, type ReplyFixture } from "../../../infrastructure/__tests__/replies-test-kit";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("AI pick apply path: type rules decide hold, draft and settle", () => {
  const { sql, modules, fixture, mail, one, count } = useReplyKit();

  const setRules = (f: ReplyFixture, key: string, rules: { check?: "before" | "after" | "skip"; draft?: boolean }) =>
    sql`update reply_types set check_mode = coalesce(${rules.check ?? null}, check_mode), reply_draft = coalesce(${rules.draft ?? null}::boolean, reply_draft)
        where organization_id = ${f.org} and key = ${key}`;
  const answer = (f: ReplyFixture, key: string, confidence = 0.95) => {
    f.ai!.classifyWith = () => ({ subcategoryKey: key, confidence, reason: "Forced." });
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
  const recordRow = (f: ReplyFixture) => one("select workflow_state, group_key, reply_type_id from records where organization_id = $1", [f.org]);

  describe("Check", () => {
    it("before: the pick waits for a person, writes the snapshot and drafts nothing", async () => {
      const f = await fixture();
      await pickOn(f, undefined, () => setRules(f, "demo_request", { check: "before" }));
      const pick = await pickRow(f);
      expect(pick).toMatchObject({ status: "proposed", rules: { checkMode: "before", replyDraft: true, followUps: "continue" }, applied_reply_type_id: null });
      expect(pick.response).toMatchObject({ holdReason: "requires_review", stopRequested: false });
      expect(await recordRow(f)).toMatchObject({ workflow_state: "action_required", group_key: null });
      expect(await count("drafts", f.org)).toBe(0);
    });

    it("after: the pick applies, drafts, and stays for Looks right", async () => {
      const f = await fixture();
      await pickOn(f);
      expect(await pickRow(f)).toMatchObject({ status: "auto_applied", rules: { checkMode: "after", replyDraft: true, followUps: "continue" } });
      expect(await recordRow(f)).toMatchObject({ workflow_state: "action_required", group_key: "interested" });
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
    });

    it("after with no draft: the pick applies and the record waits for Looks right instead of settling", async () => {
      const f = await fixture();
      await pickOn(f, undefined, () => setRules(f, "demo_request", { draft: false }));
      expect(await pickRow(f)).toMatchObject({ status: "auto_applied", rules: { checkMode: "after", replyDraft: false } });
      expect(await recordRow(f)).toMatchObject({ workflow_state: "action_required", group_key: "interested" });
      expect(await count("drafts", f.org)).toBe(0);
    });

    it("skip with a draft: the pick applies and the draft keeps the record open", async () => {
      const f = await fixture();
      await pickOn(f, undefined, () => setRules(f, "demo_request", { check: "skip" }));
      expect(await pickRow(f)).toMatchObject({ status: "auto_applied", rules: { checkMode: "skip", replyDraft: true } });
      expect(await recordRow(f)).toMatchObject({ workflow_state: "action_required" });
      expect(await count("drafts", f.org, "status = 'awaiting_review'")).toBe(1);
    });

    it("skip with no draft: the pick applies and the record settles to idle", async () => {
      const f = await fixture();
      await pickOn(f, undefined, () => setRules(f, "demo_request", { check: "skip", draft: false }));
      expect(await pickRow(f)).toMatchObject({ status: "auto_applied", rules: { checkMode: "skip", replyDraft: false } });
      expect(await recordRow(f)).toMatchObject({ workflow_state: "idle", group_key: "interested" });
      expect(await count("drafts", f.org)).toBe(0);
    });
  });

  describe("stop requests", () => {
    it("a stop request in the reply on an Interested type: applies, writes no draft and does not settle", async () => {
      const f = await fixture();
      // Skip and no stop request would settle the record; the stop request keeps it for a person.
      answer(f, "demo_request");
      await pickOn(f, "A demo could be nice, but please stop emailing me.", () => setRules(f, "demo_request", { check: "skip" }));
      const pick = await pickRow(f);
      expect(pick).toMatchObject({ status: "auto_applied" });
      expect(pick.response).toMatchObject({ stopRequested: true, holdReason: null });
      expect(await recordRow(f)).toMatchObject({ workflow_state: "action_required", group_key: "interested" });
      expect(await count("drafts", f.org)).toBe(0);
      expect(await count("contact_policies", f.org, "do_not_contact")).toBe(0);
    });

    it("an Asked to stop pick is held for a person, flagged as a stop request by its role, and marks nothing", async () => {
      const f = await fixture();
      answer(f, "do_not_contact", 0.99);
      // No stop words in the reply: the flag comes from the type's system role.
      await pickOn(f, "Thanks, that is all from me.");
      const pick = await pickRow(f);
      expect(pick).toMatchObject({ status: "proposed", rules: { checkMode: "before", replyDraft: false, followUps: "stop" } });
      expect(pick.response).toMatchObject({ holdReason: "requires_review", stopRequested: true });
      expect(await recordRow(f)).toMatchObject({ workflow_state: "action_required", group_key: null });
      expect(await count("drafts", f.org)).toBe(0);
      expect(await count("contact_policies", f.org, "do_not_contact")).toBe(0);
    });

    it("a stop request type that a person renamed is still read by its role", async () => {
      const f = await fixture();
      answer(f, "do_not_contact", 0.99);
      await pickOn(f, "Thanks.", () => sql`update reply_types set name = 'Leave me alone' where organization_id = ${f.org} and system_role = 'stop_request'`);
      expect((await pickRow(f)).response).toMatchObject({ holdReason: "requires_review", stopRequested: true });
    });
  });

  describe("fixed holds", () => {
    it("holds a pick below the confidence floor, even of a type that skips the check", async () => {
      const f = await fixture();
      answer(f, "demo_request", 0.5);
      await pickOn(f, undefined, () => setRules(f, "demo_request", { check: "skip" }));
      const pick = await pickRow(f);
      expect(pick).toMatchObject({ status: "proposed", rules: { checkMode: "skip" } });
      expect(pick.response).toMatchObject({ holdReason: "low_confidence" });
      expect(await count("drafts", f.org)).toBe(0);
    });

    it("holds a pick that would move a locked customer out of its group", async () => {
      const f = await fixture();
      answer(f, "demo_request", 0.99);
      await modules.composition.ingestInbound(mail(f));
      const [customer] = await sql`select id from reply_types where organization_id = ${f.org} and system_role = 'customer'`;
      await sql`update records set group_key = 'customer', reply_type_id = ${customer.id}, reply_type_source = 'human', reply_type_locked = true where organization_id = ${f.org}`;
      await f.run();
      const pick = await pickRow(f);
      expect(pick).toMatchObject({ status: "proposed" });
      expect(pick.response).toMatchObject({ holdReason: "protected_customer" });
      expect(await recordRow(f)).toMatchObject({ group_key: "customer", reply_type_id: customer.id });
      expect(await count("drafts", f.org)).toBe(0);
    });
  });

  describe("the customer lock on a person's pick, undo and detach", () => {
    /** The record locked on `typeId` of the customer group, as a person's type change leaves it. */
    const lockOn = (f: ReplyFixture, typeId: string) =>
      sql`update records set group_key = 'customer', reply_type_id = ${typeId}, reply_type_source = 'human', reply_type_locked = true where organization_id = ${f.org}`;
    const customerType = async (f: ReplyFixture) => (await sql`select id from reply_types where organization_id = ${f.org} and system_role = 'customer'`)[0].id as string;
    /** A second type in the customer group, without a role. */
    const renewalType = async (f: ReplyFixture) =>
      (await sql`insert into reply_types (organization_id, reply_type_set_id, group_key, key, name, sort_order)
                 select organization_id, reply_type_set_id, 'customer', 'renewal', 'Renewal', 99 from reply_types where organization_id = ${f.org} and system_role = 'customer' returning id`)[0].id as string;
    const pickRequest = async (f: ReplyFixture, replyTypeKey: string | null) => {
      const [conv] = await sql`select c.id, r.context_version from conversations c join records r on r.id = c.record_id where c.organization_id = ${f.org}`;
      return modules.stores.replies.applyHumanReplyTypePick({ organizationId: f.org, conversationId: conv.id, replyTypeKey, expectedContextVersion: conv.context_version, actorUserId: f.user });
    };
    const handling = async () => (await import("../../../infrastructure/drizzle-reply-handling-store")).drizzleReplyHandlingStore;
    const lockRow = (f: ReplyFixture) => one("select group_key, reply_type_id, reply_type_locked from records where organization_id = $1", [f.org]);

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

    it("undo restores the lock the record had before the pick, on any type of the customer group", async () => {
      const f = await fixture();
      answer(f, "customer", 0.99);
      await modules.composition.ingestInbound(mail(f));
      const renewal = await renewalType(f);
      await lockOn(f, renewal);
      await sql`update reply_types set check_mode = 'skip' where organization_id = ${f.org} and system_role = 'customer'`;
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

    it("a thread that turns private gives back the lock the record had before the AI's pick", async () => {
      const f = await fixture();
      answer(f, "customer", 0.99);
      await modules.composition.ingestInbound(mail(f));
      const renewal = await renewalType(f);
      await lockOn(f, renewal);
      await sql`update reply_types set check_mode = 'skip' where organization_id = ${f.org} and system_role = 'customer'`;
      await f.run();
      expect((await pickRow(f)).status).toBe("auto_applied");
      const [conv] = await sql`select id, record_id from conversations where organization_id = ${f.org}`;
      const { db } = await import("@/platform/db/client");
      const { detachPrivateThreadTx } = await import("../../../infrastructure/private-thread-detach");
      await db.transaction((tx) => detachPrivateThreadTx(tx, { organizationId: f.org, conversationId: conv.id, recordId: conv.record_id, now: new Date() }));
      expect(await lockRow(f)).toMatchObject({ group_key: "customer", reply_type_id: renewal, reply_type_locked: true });
    });
  });
});
