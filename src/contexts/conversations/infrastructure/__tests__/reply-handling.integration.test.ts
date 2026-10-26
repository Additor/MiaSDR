import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityPayload } from "../../application/reply-handling";
import type { InboundLinkedInInput } from "../../application/linkedin-ports";
import type { InboundEmailInput } from "../../application/ports";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { createTestOrg, describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, type TestOrg } from "@/test-support/db";

describeDb("Reply handling: stage moves, undo, do not contact, tenancy, settings", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  let composition: typeof import("../composition");
  let replies: typeof import("../../application/reply-handling");
  let deps: import("../../application/reply-handling").ReplyHandlingDeps;
  let workQueue: typeof import("../../actions/application/work-queue");
  let queueDeps: import("../../actions/application/work-queue").WorkQueueDeps;
  let replyDeps: import("../../application/reply-management").ReplyDeps;
  const orgs: TestOrg[] = [];
  let counter = 0;

  async function fixture() {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "Replies");
    orgs.push(created);
    const org = created.organizationId;
    const actor: Actor = { userId: created.userId, organizationId: org, role: "member" };
    const admin: Actor = { ...actor, role: "admin" };
    return { org, actor, admin, mailbox: `me-${tag}@corp.test`, tag };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  const mail = (f: Fx, partial: Partial<InboundEmailInput> = {}): InboundEmailInput => {
    const n = ++counter;
    return {
      organizationId: f.org,
      accountRef: f.mailbox,
      providerThreadId: `thread-${n}`,
      providerMessageId: `msg-${n}`,
      rfcMessageId: `<m${n}@lead.test>`,
      inReplyTo: null,
      from: { email: `lead${n}-${f.tag}@acme.test`, name: "Lena Lead" },
      to: [f.mailbox],
      subject: "Re: hello",
      bodyText: "Could we book a demo next week?",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      autoReply: false,
      ...partial,
    };
  };

  /** A reply from a new lead: person, record and conversation exist afterwards. */
  async function lead(f: Fx, partial: Partial<InboundEmailInput> = {}) {
    const result = await composition.ingestInbound(mail(f, partial));
    const [record] = await sql`select * from records where person_id = ${result.personId}`;
    return { ...result, recordId: record.id as string };
  }

  const sub = async (f: Fx, key: string) => {
    const taxonomy = await replies.getReplyTaxonomy(deps, f.actor);
    const found = taxonomy.subcategories.find((s) => s.key === key);
    if (!found) throw new Error(`no subcategory ${key}`);
    return found;
  };
  const rec = async (recordId: string) => (await sql`select * from records where id = ${recordId}`)[0];
  const eventTypes = async (recordId: string) => (await sql`select event_type from events where record_id = ${recordId} order by created_at`).map((r) => r.event_type as string);

  async function openDraft(f: Fx, l: { recordId: string; conversationId: string }, status = "awaiting_review") {
    const r = await rec(l.recordId);
    const [d] = await sql`
      insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, subject, ai_body_text, status)
      values (${f.org}, ${l.recordId}, ${l.conversationId}, ${r.context_version}, 'email', 'Re: hello', 'Sure, Tuesday works.', ${status}) returning id`;
    return d.id as string;
  }

  /** An AI classification for the record's latest inbound message, already applied. */
  async function appliedClassification(f: Fx, l: { recordId: string }, key: string, status = "auto_applied") {
    const target = await sub(f, key);
    const r = await rec(l.recordId);
    const [c] = await sql`
      insert into classifications (organization_id, record_id, message_id, expected_context_version, previous_category_key, previous_subcategory_id,
        proposed_category_key, proposed_subcategory_id, applied_category_key, applied_subcategory_id, confidence, reasoning, status, provider)
      values (${f.org}, ${l.recordId}, ${r.latest_inbound_message_id}, ${r.context_version}, ${r.category_key}, ${r.subcategory_id},
        ${target.categoryKey}, ${target.id}, ${status === "proposed" ? null : target.categoryKey}, ${status === "proposed" ? null : target.id}, 0.9, 'asked for a demo', ${status}, 'fake') returning id`;
    if (status !== "proposed") {
      await sql`update records set category_key = ${target.categoryKey}, subcategory_id = ${target.id}, category_source = 'ai', context_version = context_version where id = ${l.recordId}`;
    }
    return c.id as string;
  }

  beforeAll(async () => {
    composition = await import("../composition");
    replies = await import("../../application/reply-handling");
    deps = (await import("../reply-handling-composition")).replyHandlingDeps();
    workQueue = await import("../../actions/application/work-queue");
    queueDeps = (await import("../../actions/infrastructure/work-queue-composition")).workQueueDeps();
    replyDeps = (await import("../../ai/infrastructure/ai-composition")).replyDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  describe("stage moves", () => {
    it("moves a record, logs it, bumps the version and retires open drafts", async () => {
      const f = await fixture();
      const l = await lead(f);
      const draftId = await openDraft(f, l);
      const before = await rec(l.recordId);
      const meetingDone = await sub(f, "meeting_done");

      const result = await replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "interested", subcategoryId: meetingDone.id, expectedContextVersion: before.context_version, note: "Met on Tuesday" });
      expect(result).toMatchObject({ subcategoryKey: "meeting_done", contextVersion: before.context_version + 1, draftsRetired: 1 });

      const after = await rec(l.recordId);
      expect(after).toMatchObject({ category_key: "interested", subcategory_id: meetingDone.id, category_source: "human", category_locked: false, workflow_state: "action_required", context_version: before.context_version + 1 });
      expect((await sql`select status from drafts where id = ${draftId}`)[0].status).toBe("stale");
      const [event] = await sql`select * from events where record_id = ${l.recordId} and event_type = 'stage.moved'`;
      expect(event).toMatchObject({ actor_type: "human", actor_user_id: f.actor.userId, to_data: expect.objectContaining({ subcategoryId: meetingDone.id }), meta: expect.objectContaining({ note: "Met on Tuesday" }) });
    });

    it("rejects a stale version, a no-op, a mismatched category and an archived subcategory", async () => {
      const f = await fixture();
      const l = await lead(f);
      const v = (await rec(l.recordId)).context_version as number;
      const demo = await sub(f, "demo_request");
      await expect(replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "interested", subcategoryId: demo.id, expectedContextVersion: v + 5 })).rejects.toThrow(ConflictError);
      await replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "interested", subcategoryId: demo.id, expectedContextVersion: v });
      await expect(replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "interested", subcategoryId: demo.id, expectedContextVersion: v + 1 })).rejects.toThrow(/already in this category/);
      await expect(replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "customer", subcategoryId: demo.id, expectedContextVersion: v + 1 })).rejects.toThrow(ValidationError);
      const trial = await sub(f, "trial_user");
      await replies.updateSubcategory(deps, f.admin, trial.id, { active: false });
      await expect(replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "interested", subcategoryId: trial.id, expectedContextVersion: v + 1 })).rejects.toThrow(/archived/);
    });

    it("locks a customer and needs a confirmation to move them out", async () => {
      const f = await fixture();
      const l = await lead(f);
      const customer = await sub(f, "customer");
      let v = (await rec(l.recordId)).context_version as number;
      await replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "customer", subcategoryId: customer.id, expectedContextVersion: v });
      expect((await rec(l.recordId)).category_locked).toBe(true);
      v += 1;
      const other = await sub(f, "other");
      await expect(replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "other", subcategoryId: other.id, expectedContextVersion: v })).rejects.toThrow(/locked as Existing customer/);
      await replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "other", subcategoryId: other.id, expectedContextVersion: v, confirmUnlock: true });
      expect(await rec(l.recordId)).toMatchObject({ category_key: "other", category_locked: false });
    });

    it("sets do not contact and stops enrollments when the record moves to Do not contact", async () => {
      const f = await fixture();
      const l = await lead(f);
      const [campaign] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'email', 'C', 'active') returning id`;
      await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, next_send_at) values (${f.org}, ${campaign.id}, ${l.personId}, 'email', 'active', now())`;
      const dnc = await sub(f, "do_not_contact");
      await replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "not_interested", subcategoryId: dnc.id, expectedContextVersion: (await rec(l.recordId)).context_version });
      expect((await sql`select do_not_contact, source from contact_policies where person_id = ${l.personId}`)[0]).toMatchObject({ do_not_contact: true, source: "human" });
      expect((await sql`select status, stop_reason from campaign_enrollments where person_id = ${l.personId}`)[0]).toMatchObject({ status: "suppressed", stop_reason: "do_not_contact" });
    });
  });

  describe("classification undo and acknowledge", () => {
    it("restores the previous category and rejects the classification", async () => {
      const f = await fixture();
      const l = await lead(f);
      const draftId = await openDraft(f, l);
      const classificationId = await appliedClassification(f, l, "demo_request");
      const before = await rec(l.recordId);

      const result = await replies.undoClassification(deps, f.actor, classificationId);
      expect(result).toMatchObject({ recordId: l.recordId, draftsRetired: 1 });
      const after = await rec(l.recordId);
      expect(after).toMatchObject({ category_key: null, subcategory_id: null, category_source: null, workflow_state: "action_required", context_version: before.context_version + 1 });
      expect((await sql`select status, acknowledged_at from classifications where id = ${classificationId}`)[0]).toMatchObject({ status: "rejected" });
      expect((await sql`select status from drafts where id = ${draftId}`)[0].status).toBe("stale");
      expect(await eventTypes(l.recordId)).toContain("classification.undone");
      await expect(replies.undoClassification(deps, f.actor, classificationId)).rejects.toThrow(ConflictError);
    });

    it("cancels a queued draft job for the undone classification", async () => {
      const f = await fixture();
      const l = await lead(f);
      const classificationId = await appliedClassification(f, l, "demo_request");
      await sql`insert into ai_jobs (organization_id, kind, entity_type, entity_id, idempotency_key) values (${f.org}, 'initial_draft', 'classification', ${classificationId}, ${"k-" + classificationId})`;
      await replies.undoClassification(deps, f.actor, classificationId);
      expect((await sql`select status from ai_jobs where entity_id = ${classificationId}`)[0].status).toBe("failed");
    });

    it("ends the active sequence run with classification_undone, retires its drafts and cancels its steps; a second undo changes nothing", async () => {
      const f = await fixture();
      const l = await lead(f);
      const target = await sub(f, "demo_request");
      const classificationId = await appliedClassification(f, l, "demo_request");
      const r = await rec(l.recordId);
      const [{ id: seq }] = await sql`insert into sequences (organization_id, name) values (${f.org}, 'Demo follow-up') returning id`;
      // Steps go in while the version is a draft: sequence_steps_frozen_trg refuses them under a published one.
      const [{ id: ver }] = await sql`insert into sequence_versions (organization_id, sequence_id, version) values (${f.org}, ${seq}, 1) returning id`;
      const stepIds: string[] = [];
      for (const [position, type, delay] of [[1, "reply", 0], [2, "follow_up", 60]] as const) {
        const [{ id }] = await sql`
          insert into sequence_steps (organization_id, sequence_version_id, position, step_type, name, delay_minutes, ai_instructions)
          values (${f.org}, ${ver}, ${position}, ${type}, ${"Step " + position}, ${delay}, 'Write a short note.') returning id`;
        stepIds.push(id);
      }
      await sql`update sequence_versions set status = 'published', published_at = now() where id = ${ver}`;
      const [{ id: runId }] = await sql`
        insert into sequence_runs (organization_id, record_id, conversation_id, sequence_id, sequence_version_id, subcategory_id, status, started_by, trigger_message_id, last_inbound_at_start)
        values (${f.org}, ${l.recordId}, ${l.conversationId}, ${seq}, ${ver}, ${target.id}, 'active', 'ai_assignment', ${r.latest_inbound_message_id}, now()) returning id`;
      const draftId = await openDraft(f, l);
      await sql`insert into sequence_step_runs (organization_id, sequence_run_id, sequence_step_id, status, due_at, draft_id, expected_context_version) values (${f.org}, ${runId}, ${stepIds[0]}, 'awaiting_review', now(), ${draftId}, ${r.context_version})`;
      await sql`insert into sequence_step_runs (organization_id, sequence_run_id, sequence_step_id, status, due_at, expected_context_version) values (${f.org}, ${runId}, ${stepIds[1]}, 'scheduled', now() + interval '1 day', ${r.context_version})`;

      await replies.undoClassification(deps, f.actor, classificationId);

      expect((await sql`select status from sequence_runs where id = ${runId}`)[0].status).toBe("interrupted");
      expect((await sql`select status from sequence_step_runs where sequence_run_id = ${runId} order by due_at`).map((x) => x.status)).toEqual(["cancelled", "cancelled"]);
      expect((await sql`select status from drafts where id = ${draftId}`)[0].status).toBe("stale");
      const interrupted = await sql`select meta from events where record_id = ${l.recordId} and event_type = 'sequence.interrupted'`;
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0].meta).toMatchObject({ reason: "classification_undone" });

      await expect(replies.undoClassification(deps, f.actor, classificationId)).rejects.toThrow(ConflictError);
      expect(await sql`select 1 from events where record_id = ${l.recordId} and event_type = 'sequence.interrupted'`).toHaveLength(1);
      expect((await sql`select status from sequence_runs where id = ${runId}`)[0].status).toBe("interrupted");
    });

    it("refuses to undo over a later stage move, and only the latest message's classification", async () => {
      const f = await fixture();
      const l = await lead(f);
      const classificationId = await appliedClassification(f, l, "demo_request");
      const meeting = await sub(f, "meeting_requested");
      await replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "interested", subcategoryId: meeting.id, expectedContextVersion: (await rec(l.recordId)).context_version });
      await expect(replies.undoClassification(deps, f.actor, classificationId)).rejects.toThrow(/another category after this classification/);

      // A second reply makes the first message's classification history only.
      const g = await lead(f);
      const oldId = await appliedClassification(f, g, "demo_request");
      const [conv] = await sql`select provider_thread_id, account_ref from conversations where id = ${g.conversationId}`;
      await composition.ingestInbound(mail(f, { providerThreadId: conv.provider_thread_id, from: { email: "x@acme.test", name: null } }));
      await expect(replies.undoClassification(deps, f.actor, oldId)).rejects.toThrow(/latest inbound/);
    });

    it("acknowledges an applied classification and refuses a held proposal", async () => {
      const f = await fixture();
      const l = await lead(f);
      const applied = await appliedClassification(f, l, "demo_request");
      await replies.acknowledgeClassification(deps, f.actor, applied);
      expect((await sql`select acknowledged_at from classifications where id = ${applied}`)[0].acknowledged_at).not.toBeNull();
      await replies.acknowledgeClassification(deps, f.actor, applied);
      expect((await sql`select count(*)::int as n from events where record_id = ${l.recordId} and event_type = 'classification.acknowledged'`)[0].n).toBe(1);

      const g = await lead(f);
      const held = await appliedClassification(f, g, "demo_request", "proposed");
      await expect(replies.acknowledgeClassification(deps, f.actor, held)).rejects.toThrow(/Accept or change/);
    });
  });

  describe("do not contact", () => {
    it("stops pending and active enrollments, retires drafts, and leaves finished ones alone", async () => {
      const f = await fixture();
      const l = await lead(f);
      const draftId = await openDraft(f, l);
      const [campaign] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'email', 'Outbound', 'active') returning id`;
      const [campaign2] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'email', 'Second', 'active') returning id`;
      const [campaign3] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'email', 'Third', 'completed') returning id`;
      const enrol = async (campaignId: string, status: string) =>
        (await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, next_send_at) values (${f.org}, ${campaignId}, ${l.personId}, 'email', ${status}, now()) returning id`)[0].id as string;
      const active = await enrol(campaign.id, "active");
      const pending = await enrol(campaign2.id, "pending");
      const completed = await enrol(campaign3.id, "completed");
      const before = await rec(l.recordId);

      const result = await replies.setPersonDoNotContact(deps, f.actor, l.personId, { enabled: true, reason: "Asked on a call" });
      expect(result).toMatchObject({ changed: true, doNotContact: true, recordsUpdated: 1, draftsRetired: 1, enrollmentsStopped: 2 });

      const status = async (id: string) => (await sql`select status, stop_reason, next_send_at from campaign_enrollments where id = ${id}`)[0];
      expect(await status(active)).toMatchObject({ status: "suppressed", stop_reason: "do_not_contact", next_send_at: null });
      expect(await status(pending)).toMatchObject({ status: "suppressed", stop_reason: "do_not_contact" });
      expect(await status(completed)).toMatchObject({ status: "completed", stop_reason: null });
      expect((await sql`select status from drafts where id = ${draftId}`)[0].status).toBe("stale");
      expect(await rec(l.recordId)).toMatchObject({ workflow_state: "action_required", context_version: before.context_version + 1 });
      expect(await eventTypes(l.recordId)).toContain("contact_policy.enforced");
      expect((await sql`select do_not_contact, reason, source, cleared_at from contact_policies where person_id = ${l.personId}`)[0]).toMatchObject({ do_not_contact: true, reason: "Asked on a call", source: "human", cleared_at: null });

      // Setting it again changes nothing.
      expect(await replies.setPersonDoNotContact(deps, f.actor, l.personId, { enabled: true, reason: "again" })).toMatchObject({ changed: false });
      expect((await rec(l.recordId)).context_version).toBe(before.context_version + 1);
    });

    it("clears the flag without restarting stopped enrollments", async () => {
      const f = await fixture();
      const l = await lead(f);
      const [campaign] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'email', 'Outbound', 'active') returning id`;
      await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${f.org}, ${campaign.id}, ${l.personId}, 'email', 'active')`;
      await replies.setPersonDoNotContact(deps, f.actor, l.personId, { enabled: true, reason: "x" });
      expect(await replies.setPersonDoNotContact(deps, f.actor, l.personId, { enabled: false })).toMatchObject({ changed: true, doNotContact: false });
      expect((await sql`select do_not_contact, cleared_at from contact_policies where person_id = ${l.personId}`)[0]).toMatchObject({ do_not_contact: false });
      expect((await sql`select status from campaign_enrollments where person_id = ${l.personId}`)[0].status).toBe("suppressed");
      expect((await sql`select event_type from events where person_id = ${l.personId}`).map((r) => r.event_type)).toEqual(expect.arrayContaining(["contact_policy.dnc_set", "contact_policy.dnc_cleared"]));
      // Clearing a person that was never marked changes nothing.
      const g = await lead(f);
      expect(await replies.setPersonDoNotContact(deps, f.actor, g.personId, { enabled: false })).toMatchObject({ changed: false });
    });

    it("blocks the reply gate after do not contact: the approved draft is retired and cannot be sent", async () => {
      const f = await fixture();
      const l = await lead(f);
      const draftId = await openDraft(f, l);
      await replies.setPersonDoNotContact(deps, f.actor, l.personId, { enabled: true, reason: "Asked to stop" });
      const mgmt = await import("../../application/reply-management");
      await expect(mgmt.approveAndSendDraft(replyDeps, f.actor, draftId, { revision: 1, idempotencyKey: `key-${Math.random().toString(36).slice(2)}` })).rejects.toThrow(ConflictError);
      expect((await sql`select count(*)::int as n from send_attempts where draft_id = ${draftId}`)[0].n).toBe(0);
    });
  });

  describe("tenant isolation", () => {
    it("never shows, reads or changes another organization's records", async () => {
      const a = await fixture();
      const b = await fixture();
      const la = await lead(a);
      const lb = await lead(b);
      await openDraft(a, la);
      const classificationId = await appliedClassification(a, la, "demo_request");

      // Reads
      expect((await workQueue.getWorkQueue(queueDeps, b.actor)).groups.reply.items).toHaveLength(0);
      await expect(replies.getRecord(deps, b.actor, la.recordId)).rejects.toThrow(NotFoundError);

      // Writes
      const v = (await rec(la.recordId)).context_version as number;
      const meeting = await sub(a, "meeting_done");
      await expect(replies.moveRecordStage(deps, b.actor, la.recordId, { categoryKey: "interested", subcategoryId: meeting.id, expectedContextVersion: v })).rejects.toThrow(NotFoundError);
      await expect(replies.moveRecordStage(deps, b.actor, lb.recordId, { categoryKey: "interested", subcategoryId: meeting.id, expectedContextVersion: 0 })).rejects.toThrow(NotFoundError);
      await expect(replies.undoClassification(deps, b.actor, classificationId)).rejects.toThrow(NotFoundError);
      await expect(replies.acknowledgeClassification(deps, b.actor, classificationId)).rejects.toThrow(NotFoundError);
      await expect(replies.setPersonDoNotContact(deps, b.actor, la.personId, { enabled: true, reason: "x" })).rejects.toThrow(NotFoundError);
      await expect(replies.closeRecord(deps, b.actor, la.recordId, { reason: "x" })).rejects.toThrow(NotFoundError);
      await expect(replies.addRecordNote(deps, b.actor, la.recordId, { body: "hi" })).rejects.toThrow(NotFoundError);
      await expect(replies.updateSubcategory(deps, b.admin, meeting.id, { active: false })).rejects.toThrow(NotFoundError);
      await expect(replies.deleteSubcategory(deps, b.admin, meeting.id)).rejects.toThrow(NotFoundError);
      expect(await rec(la.recordId)).toMatchObject({ context_version: v, category_source: "ai" });
      expect((await sql`select count(*)::int as n from contact_policies where person_id = ${la.personId}`)[0].n).toBe(0);
      expect((await sql`select active from subcategories where id = ${meeting.id}`)[0].active).toBe(true);
    });
  });

  describe("close, reopen and notes", () => {
    let f: Fx;
    beforeAll(async () => {
      f = await fixture();
    });

    it("closes a record with a reason and refuses a stage move while it is closed", async () => {
      const l = await lead(f);
      await replies.closeRecord(deps, f.actor, l.recordId, { reason: "Went with a competitor" });
      expect(await rec(l.recordId)).toMatchObject({ workflow_state: "closed", closed_reason: "Went with a competitor" });
      const demo = await sub(f, "demo_request");
      await expect(replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "interested", subcategoryId: demo.id, expectedContextVersion: (await rec(l.recordId)).context_version })).rejects.toThrow(/closed/);
    });

    it("reopens a closed record once", async () => {
      const l = await lead(f);
      await replies.closeRecord(deps, f.actor, l.recordId, { reason: "Went with a competitor" });
      await replies.reopenRecord(deps, f.actor, l.recordId);
      expect(await rec(l.recordId)).toMatchObject({ workflow_state: "action_required", closed_reason: null });
      await expect(replies.reopenRecord(deps, f.actor, l.recordId)).rejects.toThrow(ConflictError);
    });

    it("adds a note, rejects a blank one, and deletes a note once", async () => {
      const l = await lead(f);
      const note = await replies.addRecordNote(deps, f.actor, l.recordId, { body: "  First  " });
      await expect(replies.addRecordNote(deps, f.actor, l.recordId, { body: " " })).rejects.toThrow(ValidationError);
      await replies.deleteRecordNote(deps, f.actor, l.recordId, note.id);
      await expect(replies.deleteRecordNote(deps, f.actor, l.recordId, note.id)).rejects.toThrow(NotFoundError);
    });
  });

  describe("settings", () => {
    let f: Fx;
    beforeAll(async () => {
      f = await fixture();
    });

    it("creates a subcategory and saves edits to it", async () => {
      const created = await replies.createSubcategory(deps, f.admin, { categoryKey: "interested", name: "Pricing question", classificationGuidance: "Asks what it costs.", reviewRequired: true, stageRank: 2 });
      expect(await sub(f, "pricing_question")).toMatchObject({ id: created.id, reviewRequired: true, stageRank: 2, classificationGuidance: "Asks what it costs.", recordCount: 0 });
      await replies.updateSubcategory(deps, f.admin, created.id, { name: "Pricing questions", reviewRequired: false, stageRank: null });
      expect(await sub(f, "pricing_question")).toMatchObject({ name: "Pricing questions", reviewRequired: false, stageRank: null });
    });

    it("refuses to delete a subcategory a record is in, and archives it instead", async () => {
      const created = await replies.createSubcategory(deps, f.admin, { categoryKey: "interested", name: "Contract review" });
      const l = await lead(f);
      await replies.moveRecordStage(deps, f.actor, l.recordId, { categoryKey: "interested", subcategoryId: created.id, expectedContextVersion: (await rec(l.recordId)).context_version });
      await expect(replies.deleteSubcategory(deps, f.admin, created.id)).rejects.toThrow(/1 person is in/);
      await replies.updateSubcategory(deps, f.admin, created.id, { active: false });
      expect((await sub(f, "contract_review")).active).toBe(false);
    });

    it("deletes an unused subcategory", async () => {
      const spare = await replies.createSubcategory(deps, f.admin, { categoryKey: "other", name: "Spare" });
      await replies.deleteSubcategory(deps, f.admin, spare.id);
      expect((await replies.getReplyTaxonomy(deps, f.actor)).subcategories.some((s) => s.id === spare.id)).toBe(false);
    });

    it("saves the thresholds and draft instructions, and rejects a confidence above 1", async () => {
      await replies.updateReplySettings(deps, f.admin, { autoApplyConfidence: 0.7, reviewOther: false });
      await replies.updateReplyAiInstructions(deps, f.admin, { draftInstructions: [{ id: "tone", title: "Tone", content: "Short and warm." }] });
      const { settings } = await replies.getReplyTaxonomy(deps, f.actor);
      expect(settings).toMatchObject({ autoApplyConfidence: 0.7, reviewOther: false, customerRequiresReview: true, draftInstructions: [{ id: "tone", title: "Tone", content: "Short and warm." }], classificationInstructions: [] });
      await expect(replies.updateReplySettings(deps, f.admin, { autoApplyConfidence: 2 })).rejects.toThrow(ValidationError);
    });
  });

  describe("send attempts", () => {
    it("settles an uncertain reply by attempt id without sending", async () => {
      const f = await fixture();
      const l = await lead(f);
      const draftId = await openDraft(f, l, "delivery_uncertain");
      const [attempt] = await sql`
        insert into send_attempts (organization_id, draft_id, idempotency_key, status, actor_user_id, request)
        values (${f.org}, ${draftId}, ${"k-" + draftId}, 'delivery_uncertain', ${f.actor.userId},
          ${sql.json({ personId: l.personId, recordId: l.recordId, conversationId: l.conversationId, to: "x@y.test", accountRef: f.mailbox } as never)}) returning id`;
      const queue = await workQueue.getWorkQueue(queueDeps, f.actor);
      expect(queue.groups.problem.items).toMatchObject([{ recordId: l.recordId, draft: { draftId }, problem: { kind: "delivery_uncertain" } }]);

      const other = await fixture();
      await expect(replies.reconcileSendAttempt(deps, replyDeps, other.actor, attempt.id, { delivered: false, note: "checked" })).rejects.toThrow(NotFoundError);
      await replies.reconcileSendAttempt(deps, replyDeps, f.actor, attempt.id, { delivered: false, note: "Not in the Sent folder" });
      expect((await sql`select status, reconciliation_note from send_attempts where id = ${attempt.id}`)[0]).toMatchObject({ status: "failed", reconciliation_note: expect.stringContaining("Not in the Sent folder") });
      expect((await sql`select status from drafts where id = ${draftId}`)[0].status).toBe("failed");
    });
  });

  describe("identity exceptions", () => {
    const payloadFor = (f: Fx, over: Partial<Extract<IdentityPayload, { kind: "email" }>["message"]> = {}): IdentityPayload => ({
      kind: "email",
      message: { accountRef: f.mailbox, providerThreadId: `qt-${++counter}`, providerMessageId: `qm-${counter}`, rfcMessageId: null, inReplyTo: null, from: { email: `colleague-${counter}-${f.tag}@acme.test`, name: "Colleague" }, to: [f.mailbox], subject: "Re: intro", bodyText: "Pat is the right person.", receivedAt: "2026-10-14T09:00:00.000Z", autoReply: false, ...over },
    });

    it("quarantines once, resolves by filing the message under the chosen person, and refuses repeats", async () => {
      const f = await fixture();
      const target = await lead(f);
      const payload = payloadFor(f);
      const first = await replies.quarantineInbound(deps, { organizationId: f.org, sourceEventKey: "gmail:q1", identityValue: "colleague", reason: "Sender does not match the lead", payload });
      const again = await replies.quarantineInbound(deps, { organizationId: f.org, sourceEventKey: "gmail:q1", identityValue: "colleague", reason: "Sender does not match the lead", payload });
      expect(again).toMatchObject({ id: first.id, created: false });
      expect(await replies.listIdentityExceptions(deps, f.actor)).toHaveLength(1);

      const before = (await rec(target.recordId)).context_version as number;
      const resolved = await replies.resolveIdentityException(deps, f.actor, first.id, { personId: target.personId });
      const [message] = await sql`select m.*, c.record_id from messages m join conversations c on c.id = m.conversation_id where m.id in (select id from messages where conversation_id = ${resolved.conversationId})`;
      expect(message).toMatchObject({ record_id: target.recordId, direction: "inbound", body_text: "Pat is the right person." });
      expect((await rec(target.recordId)).context_version).toBeGreaterThan(before);
      expect((await sql`select status, resolved_person_id from identity_exceptions where id = ${first.id}`)[0]).toMatchObject({ status: "resolved", resolved_person_id: target.personId });
      expect(await replies.listIdentityExceptions(deps, f.actor)).toHaveLength(0);
      await expect(replies.resolveIdentityException(deps, f.actor, first.id, { personId: target.personId })).rejects.toThrow(/already reviewed/);
      // The replay created no new person.
      expect((await sql`select count(*)::int as n from people where organization_id = ${f.org}`)[0].n).toBe(1);
    });

    it("parks an email with an unusable sender at ingest, stores nothing else, and replays it under a chosen person", async () => {
      const f = await fixture();
      const target = await lead(f);
      const input = mail(f, { from: { email: "undisclosed-recipients", name: "Pat" }, bodyText: "Please loop in Lena." });
      const first = await composition.receiveInbound(input);
      const again = await composition.receiveInbound(input);
      expect(first).toMatchObject({ status: "quarantined" });
      expect(again).toMatchObject({ status: "quarantined", exceptionId: (first as { exceptionId: string }).exceptionId });
      expect((await sql`select count(*)::int as n from messages where organization_id = ${f.org}`)[0].n).toBe(1);
      const open = await replies.listIdentityExceptions(deps, f.actor);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ channel: "email", identityValue: "undisclosed-recipients", sourceEventKey: `gmail:${f.mailbox}:${input.providerMessageId}` });

      const resolved = await replies.resolveIdentityException(deps, f.actor, open[0].id, { personId: target.personId });
      const [filed] = await sql`select m.body_text, c.record_id from messages m join conversations c on c.id = m.conversation_id where m.conversation_id = ${resolved.conversationId}`;
      expect(filed).toMatchObject({ body_text: "Please loop in Lena.", record_id: target.recordId });
      expect(await replies.listIdentityExceptions(deps, f.actor)).toHaveLength(0);
      expect((await sql`select count(*)::int as n from people where organization_id = ${f.org}`)[0].n).toBe(1);
    });

    it("does not park a normal unknown sender: the inbox keeps creating an inbound person", async () => {
      const f = await fixture();
      expect(await composition.receiveInbound(mail(f))).toMatchObject({ status: "created", personCreated: true });
      expect(await replies.listIdentityExceptions(deps, f.actor)).toHaveLength(0);
    });

    it("parks a LinkedIn message from a new chat with no profile identity, then replays it", async () => {
      const f = await fixture();
      const target = await lead(f);
      const n = ++counter;
      const input: InboundLinkedInInput = {
        organizationId: f.org, accountRef: `acct-${f.tag}`, accountName: "Jo", providerThreadId: `chat-${n}`, providerMessageId: `lm-${n}`,
        counterparty: { providerId: `ACo-${n}`, name: null, profileUrl: null, slug: null }, personId: null, bodyText: "Hi there", receivedAt: new Date("2026-10-14T10:00:00Z"),
      };
      const out = await composition.receiveInboundLinkedIn(input);
      expect(out.status).toBe("quarantined");
      expect((await composition.receiveInboundLinkedIn(input)).status).toBe("quarantined");
      expect((await sql`select count(*)::int as n from people where organization_id = ${f.org}`)[0].n).toBe(1);
      const open = await replies.listIdentityExceptions(deps, f.actor);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ channel: "linkedin", identityValue: `ACo-${n}`, sourceEventKey: `linkedin:acct-${f.tag}:lm-${n}` });

      const resolved = await replies.resolveIdentityException(deps, f.actor, open[0].id, { personId: target.personId });
      const [filed] = await sql`select m.body_text, c.record_id, c.channel from messages m join conversations c on c.id = m.conversation_id where m.conversation_id = ${resolved.conversationId}`;
      expect(filed).toMatchObject({ body_text: "Hi there", record_id: target.recordId, channel: "linkedin" });
    });

    it("files a LinkedIn message with a profile slug, or in a known chat, without parking it", async () => {
      const f = await fixture();
      const n = ++counter;
      const base: InboundLinkedInInput = {
        organizationId: f.org, accountRef: `acct-${f.tag}`, accountName: "Jo", providerThreadId: `chat-${n}`, providerMessageId: `lm-${n}`,
        counterparty: { providerId: `ACo-${n}`, name: "Ada", profileUrl: `https://www.linkedin.com/in/ada-${n}`, slug: `ada-${n}` }, personId: null, bodyText: "Hi", receivedAt: new Date("2026-10-14T10:00:00Z"),
      };
      expect((await composition.receiveInboundLinkedIn(base)).status).toBe("created");
      const noSlug = { ...base, providerMessageId: `lm-${n}b`, counterparty: { ...base.counterparty, slug: null, profileUrl: null } };
      expect((await composition.receiveInboundLinkedIn(noSlug)).status).toBe("created");
      expect(await replies.listIdentityExceptions(deps, f.actor)).toHaveLength(0);
    });

    it("ignores an exception and keeps another organization's exceptions out of reach", async () => {
      const f = await fixture();
      const g = await fixture();
      const target = await lead(g);
      const q = await replies.quarantineInbound(deps, { organizationId: f.org, sourceEventKey: "gmail:q2", identityValue: null, reason: "Unknown sender", payload: payloadFor(f) });
      await expect(replies.resolveIdentityException(deps, g.actor, q.id, { personId: target.personId })).rejects.toThrow(NotFoundError);
      await expect(replies.ignoreIdentityException(deps, g.actor, q.id)).rejects.toThrow(NotFoundError);
      expect(await replies.listIdentityExceptions(deps, g.actor)).toHaveLength(0);
      // A person of another organization cannot receive the message.
      await expect(replies.resolveIdentityException(deps, f.actor, q.id, { personId: target.personId })).rejects.toThrow(NotFoundError);
      await replies.ignoreIdentityException(deps, f.actor, q.id);
      expect((await sql`select status, resolved_person_id from identity_exceptions where id = ${q.id}`)[0]).toMatchObject({ status: "ignored", resolved_person_id: null });
      expect((await sql`select count(*)::int as n from messages where organization_id = ${f.org}`)[0].n).toBe(0);
    });
  });
});
