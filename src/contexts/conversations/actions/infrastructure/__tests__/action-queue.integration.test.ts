import { afterAll, beforeAll, expect, it } from "vitest";
import { encodeQueueCursor, isInQueue, queueGroupOf, waitingSince, type QueueFacts, type QueueGroup } from "../../domain/action-queue";
import type { InboundEmailInput } from "../../../application/ports";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("CRM Actions queue: state-based groups, filters, keyset paging, counts", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  let composition: typeof import("../../../infrastructure/composition");
  let workQueue: typeof import("../../application/work-queue");
  let deps: import("../../application/work-queue").WorkQueueDeps;
  const orgs: string[] = [];
  const users: string[] = [];
  let counter = 0;

  async function fixture() {
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('Queue', ${"queue-" + tag}) returning id`;
    orgs.push(org);
    const [{ id: user }] = await sql`insert into users (name, email) values ('Rep', ${`rep-${tag}@x.test`}) returning id`;
    users.push(user);
    const actor: Actor = { userId: user, organizationId: org, role: "member" };
    return { org, actor, mailbox: `me-${tag}@corp.test`, tag };
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
      from: { email: `lead${n}-${f.tag}@acme.test`, name: `Lead ${n}` },
      to: [f.mailbox],
      subject: "Re: hello",
      bodyText: "Could we book a demo next week?",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      autoReply: false,
      ...partial,
    };
  };

  /** A reply from a new lead: the record is `action_required` with nothing attached. */
  async function lead(f: Fx, partial: Partial<InboundEmailInput> = {}) {
    const result = await composition.ingestInbound(mail(f, partial));
    const [record] = await sql`select * from records where person_id = ${result.personId}`;
    return { ...result, recordId: record.id as string };
  }

  const rec = async (recordId: string) => (await sql`select * from records where id = ${recordId}`)[0];

  async function draft(f: Fx, l: { recordId: string; conversationId: string }, status = "awaiting_review", error: string | null = null) {
    const r = await rec(l.recordId);
    const [d] = await sql`
      insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, subject, ai_body_text, status, error)
      values (${f.org}, ${l.recordId}, ${l.conversationId}, ${r.context_version}, 'email', 'Re: hello', 'Sure.', ${status}, ${error}) returning id`;
    return d.id as string;
  }

  async function classification(f: Fx, l: { recordId: string }, status = "auto_applied") {
    const [target] = await sql`select id, category_key from subcategories where organization_id = ${f.org} and key = 'demo_request'`;
    const r = await rec(l.recordId);
    const [c] = await sql`
      insert into classifications (organization_id, record_id, message_id, expected_context_version, previous_category_key, previous_subcategory_id,
        proposed_category_key, proposed_subcategory_id, applied_category_key, applied_subcategory_id, confidence, reasoning, status, provider)
      values (${f.org}, ${l.recordId}, ${r.latest_inbound_message_id}, ${r.context_version}, null, null,
        ${target.category_key}, ${target.id}, ${status === "proposed" ? null : target.category_key}, ${status === "proposed" ? null : target.id}, 0.9, 'asked for a demo', ${status}, 'fake') returning id`;
    return c.id as string;
  }

  const queue = (f: Fx, input: Parameters<typeof workQueue.getWorkQueue>[2] = {}) => workQueue.getWorkQueue(deps, f.actor, input);
  const ids = (page: { items: Array<{ recordId: string }> }) => page.items.map((i) => i.recordId);

  beforeAll(async () => {
    composition = await import("../../../infrastructure/composition");
    workQueue = await import("../../application/work-queue");
    deps = (await import("../work-queue-composition")).workQueueDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("lists an action_required record that has no draft, classification or task as next_step", async () => {
    const f = await fixture();
    const l = await lead(f);
    const q = await queue(f);
    expect(q.groups.next_step.items).toMatchObject([{ recordId: l.recordId, group: "next_step", workflowState: "action_required", draft: null, classification: null, problem: null }]);
    expect(q.total).toBe(1);

    // An open task already puts the record in front of a person, so it leaves next_step. A done task does not.
    const [task] = await sql`insert into tasks (organization_id, person_id, record_id, name) values (${f.org}, ${l.personId}, ${l.recordId}, 'Call') returning id`;
    expect((await queue(f)).groups.next_step.total).toBe(0);
    await sql`update tasks set is_completed = true, completed_at = now() where id = ${task.id}`;
    expect((await queue(f)).groups.next_step.total).toBe(1);
  });

  it("puts each record in one group, problem first, and leaves idle and not-yet-due records out", async () => {
    const f = await fixture();
    const reply = await lead(f);
    await draft(f, reply);
    const review = await lead(f);
    await classification(f, review, "proposed");
    const both = await lead(f);
    await draft(f, both);
    await draft(f, both, "failed", "Body is empty");
    const due = await lead(f);
    await sql`update records set workflow_state = 'waiting', next_action_at = now() - interval '1 hour' where id = ${due.recordId}`;
    const notDue = await lead(f);
    await sql`update records set workflow_state = 'waiting', next_action_at = now() + interval '3 days' where id = ${notDue.recordId}`;
    const idle = await lead(f);
    await sql`update records set workflow_state = 'idle' where id = ${idle.recordId}`;
    const closed = await lead(f);
    await sql`update records set workflow_state = 'closed' where id = ${closed.recordId}`;
    const errored = await lead(f);
    await sql`update records set workflow_state = 'error' where id = ${errored.recordId}`;

    const q = await queue(f);
    expect(ids(q.groups.reply)).toEqual([reply.recordId]);
    expect(q.groups.classification.items).toMatchObject([{ recordId: review.recordId, classification: { kind: "held", name: "Demo request" } }]);
    expect(ids(q.groups.follow_up)).toEqual([due.recordId]);
    expect(ids(q.groups.problem).sort()).toEqual([both.recordId, errored.recordId].sort());
    expect(q.groups.problem.items.find((i) => i.recordId === both.recordId)?.problem).toMatchObject({ kind: "draft_failed", message: "Body is empty" });
    expect(q.groups.problem.items.find((i) => i.recordId === errored.recordId)?.problem?.kind).toBe("record_error");
    expect(q.groups.next_step.total).toBe(0);
    expect(q.total).toBe(5);
  });

  it("shows a failed draft job, an unconfirmed reply and a failed classification job as problems", async () => {
    const f = await fixture();
    const failedDraftJob = await lead(f);
    const classificationId = await classification(f, failedDraftJob);
    await sql`
      insert into ai_jobs (organization_id, kind, entity_type, entity_id, idempotency_key, status, attempts, failed_at, last_error)
      values (${f.org}, 'initial_draft', 'classification', ${classificationId}, ${"k-" + classificationId}, 'failed', 3, now(), 'Model refused the request')`;
    const failedClassify = await lead(f);
    const r = await rec(failedClassify.recordId);
    await sql`
      insert into ai_jobs (organization_id, kind, entity_type, entity_id, idempotency_key, status, attempts, failed_at, last_error)
      values (${f.org}, 'classification', 'message', ${r.latest_inbound_message_id}, ${"k-" + r.latest_inbound_message_id}, 'failed', 3, now(), 'Provider timeout')`;
    const uncertain = await lead(f);
    await draft(f, uncertain, "delivery_uncertain", "No reply from the mailbox");

    const q = await queue(f);
    const byRecord = new Map(q.groups.problem.items.map((i) => [i.recordId, i.problem]));
    expect(byRecord.get(failedDraftJob.recordId)).toEqual({ kind: "job_failed", message: "Model refused the request" });
    expect(byRecord.get(failedClassify.recordId)).toEqual({ kind: "job_failed", message: "Provider timeout" });
    expect(byRecord.get(uncertain.recordId)).toMatchObject({ kind: "delivery_uncertain", message: "No reply from the mailbox" });
    expect(q.groups.problem.total).toBe(3);

    // A person who writes the reply by hand clears the draft-job problem.
    await draft(f, failedDraftJob);
    const after = await queue(f);
    expect(ids(after.groups.problem)).not.toContain(failedDraftJob.recordId);
    expect(ids(after.groups.reply)).toContain(failedDraftJob.recordId);
  });

  it("pages 120 drafts past 50 with an exact total, no duplicates and no gaps", async () => {
    const f = await fixture();
    const expected: string[] = [];
    // The same receivedAt for every lead forces ties on the sort time, so the record id has to break them.
    for (let i = 0; i < 120; i++) {
      const l = await lead(f);
      await draft(f, l);
      expected.push(l.recordId);
    }
    const first = await queue(f);
    expect(first.groups.reply.total).toBe(120);
    expect(first.groups.reply.items).toHaveLength(50);
    expect(first.groups.reply.nextCursor).not.toBeNull();

    const seen = [...ids(first.groups.reply)];
    let cursor = first.groups.reply.nextCursor;
    let pages = 1;
    while (cursor) {
      const next = await queue(f, { filter: { group: "reply" }, cursor });
      expect(next.groups.reply.total).toBe(120);
      seen.push(...ids(next.groups.reply));
      cursor = next.groups.reply.nextCursor;
      pages++;
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    expect([...seen].sort()).toEqual([...expected].sort());

    const big = await queue(f, { limit: 500 });
    expect(big.groups.reply.items).toHaveLength(120);
    const small = await queue(f, { limit: 7, filter: { group: "reply" } });
    expect(small.groups.reply.items).toHaveLength(7);
    expect((await queue(f, { limit: 0 })).groups.reply.items).toHaveLength(50);
  });

  it("filters by category, channel, action type, due window, subcategory, sequence and errors only", async () => {
    const f = await fixture();
    const demo = await lead(f);
    const [sub] = await sql`select id, category_key from subcategories where organization_id = ${f.org} and key = 'demo_request'`;
    await sql`update records set category_key = ${sub.category_key}, subcategory_id = ${sub.id}, category_source = 'human' where id = ${demo.recordId}`;
    await draft(f, demo);
    const plain = await lead(f);
    const linkedin = await lead(f);
    await sql`update records set active_channel = 'linkedin' where id = ${linkedin.recordId}`;
    const dueSoon = await lead(f);
    await sql`update records set workflow_state = 'waiting', next_action_at = '2026-10-10T00:00:00Z' where id = ${dueSoon.recordId}`;
    const dueEarlier = await lead(f);
    await sql`update records set workflow_state = 'waiting', next_action_at = '2026-10-01T00:00:00Z' where id = ${dueEarlier.recordId}`;
    const broken = await lead(f);
    await sql`update records set workflow_state = 'error' where id = ${broken.recordId}`;

    const all = (q: Awaited<ReturnType<typeof queue>>) => QUEUE_ORDER.flatMap((g) => ids(q.groups[g])).sort();
    const QUEUE_ORDER: QueueGroup[] = ["reply", "follow_up", "classification", "next_step", "problem"];

    expect(all(await queue(f, { filter: { category: "interested" } }))).toEqual([demo.recordId]);
    expect(all(await queue(f, { filter: { category: "unclassified" } }))).toEqual([plain.recordId, linkedin.recordId, dueSoon.recordId, dueEarlier.recordId, broken.recordId].sort());
    expect(all(await queue(f, { filter: { channel: "linkedin" } }))).toEqual([linkedin.recordId]);
    expect(all(await queue(f, { filter: { subcategoryId: sub.id } }))).toEqual([demo.recordId]);

    const typed = await queue(f, { filter: { group: "follow_up" } });
    expect(ids(typed.groups.follow_up).sort()).toEqual([dueSoon.recordId, dueEarlier.recordId].sort());
    expect(typed.groups.reply.items).toEqual([]);
    expect(typed.groups.reply.total).toBe(1);

    expect(all(await queue(f, { filter: { dueBefore: "2026-10-05" } }))).toEqual([dueEarlier.recordId]);
    expect(all(await queue(f, { filter: { dueBefore: "2026-10-10" } }))).toEqual([dueSoon.recordId, dueEarlier.recordId].sort());
    expect(all(await queue(f, { filter: { dueAfter: "2026-10-05T00:00:00Z" } }))).toEqual([dueSoon.recordId]);
    expect(all(await queue(f, { filter: { dueAfter: "2026-10-02", dueBefore: "2026-10-30" } }))).toEqual([dueSoon.recordId]);

    const errors = await queue(f, { filter: { errorsOnly: "1" } });
    expect(ids(errors.groups.problem)).toEqual([broken.recordId]);
    expect(errors.groups.reply.items).toEqual([]);

    // The campaign filter keeps the records of people enrolled in that campaign.
    const person = (await sql`select person_id from records where id = ${plain.recordId}`)[0].person_id as string;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'email', 'Autumn', 'active') returning id`;
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${f.org}, ${campaign}, ${person}, 'email', 'replied')`;
    expect(all(await queue(f, { filter: { campaignId: campaign } }))).toEqual([plain.recordId]);
    expect(all(await queue(f, { filter: { campaignId: "00000000-0000-4000-8000-000000000000" } }))).toEqual([]);
    await expect(queue(f, { filter: { campaignId: "not-a-uuid" } })).rejects.toThrow(ValidationError);
  });

  it("the campaign filter means people currently enrolled: active and replied match, removed does not, on both channels", async () => {
    const f = await fixture();
    const active = await lead(f);
    const replied = await lead(f);
    const removed = await lead(f);
    const stranger = await lead(f);
    const personOf = async (l: { recordId: string }) => (await sql`select person_id from records where id = ${l.recordId}`)[0].person_id as string;
    const enroll = async (campaign: string, l: { recordId: string }, status: string, channel = "email") =>
      sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${f.org}, ${campaign}, ${await personOf(l)}, ${channel}, ${status})`;
    const [{ id: email }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'email', 'Autumn', 'active') returning id`;
    await enroll(email, active, "active");
    await enroll(email, replied, "replied");
    await enroll(email, removed, "removed");
    const matches = async (campaignId: string) => ids((await queue(f, { filter: { campaignId } })).groups.next_step).sort();
    expect(await matches(email)).toEqual([active.recordId, replied.recordId].sort());

    // A person removed from one campaign and still enrolled in another shows under the other only.
    const [{ id: linkedin }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'linkedin', 'Connect', 'active') returning id`;
    await enroll(linkedin, removed, "active", "linkedin");
    await enroll(linkedin, active, "removed", "linkedin");
    expect(await matches(linkedin)).toEqual([removed.recordId]);
    expect(await matches(email)).toEqual([active.recordId, replied.recordId].sort());
    // Without the filter the queue holds the stranger too, so the filter is what leaves them out.
    expect(ids((await queue(f)).groups.next_step).sort()).toEqual([active.recordId, replied.recordId, removed.recordId, stranger.recordId].sort());
    // The totals use the same filter.
    expect((await queue(f, { filter: { campaignId: email } })).total).toBe(2);
  });

  it("rejects bad filters and cursors", async () => {
    const f = await fixture();
    await expect(queue(f, { filter: { channel: "fax" } })).rejects.toThrow(ValidationError);
    await expect(queue(f, { filter: { group: "everything" } })).rejects.toThrow(ValidationError);
    await expect(queue(f, { filter: { subcategoryId: "not-a-uuid" } })).rejects.toThrow(ValidationError);
    await expect(queue(f, { filter: { dueBefore: "soon" } })).rejects.toThrow(ValidationError);
    await expect(queue(f, { filter: { group: "reply", errorsOnly: "1" } })).rejects.toThrow(ValidationError);
    await expect(queue(f, { filter: { group: "reply" }, cursor: "garbage" })).rejects.toThrow(ValidationError);
    await expect(queue(f, { cursor: encodeQueueCursor({ sortKey: "2026-10-14 10:00:00+00", recordId: "00000000-0000-4000-8000-000000000000" }) })).rejects.toThrow(/action type/);
    // A cursor from the newest-first order is refused instead of continued.
    await expect(queue(f, { filter: { group: "reply" }, cursor: Buffer.from(JSON.stringify(["2026-10-14 10:00:00+00", "00000000-0000-4000-8000-000000000000"])).toString("base64url") })).rejects.toThrow(/Reload the queue/);
  });

  it("keeps organizations apart", async () => {
    const a = await fixture();
    const b = await fixture();
    const la = await lead(a);
    await draft(a, la);
    const lb = await lead(b);
    expect(ids((await queue(b)).groups.reply)).toEqual([]);
    expect(ids((await queue(b)).groups.next_step)).toEqual([lb.recordId]);
    expect((await queue(b)).total).toBe(1);
    expect((await workQueue.getWorkQueueCounts(deps, b.actor)).total).toBe(1);
    // A cursor from another organization cannot reach this one's rows: it only moves the position.
    const aPage = await queue(a, { limit: 1 });
    expect(aPage.groups.reply.items).toHaveLength(1);
  });

  it("counts for the badges come from the same query as the page total", async () => {
    const f = await fixture();
    const l1 = await lead(f);
    await draft(f, l1);
    const l2 = await lead(f);
    await sql`update records set workflow_state = 'error' where id = ${l2.recordId}`;
    await lead(f);
    const due = await lead(f);
    await sql`update records set workflow_state = 'waiting', next_action_at = now() - interval '1 minute' where id = ${due.recordId}`;

    const page = await queue(f);
    const counts = await workQueue.getWorkQueueCounts(deps, f.actor);
    expect(page.total).toBe(4);
    expect(counts.total).toBe(page.total);
    for (const g of ["reply", "follow_up", "classification", "next_step", "problem"] as const) {
      expect(counts.byGroup[g]).toBe(page.groups[g].total);
    }
    // A filter narrows the page but never the badge.
    expect((await queue(f, { filter: { group: "reply" } })).total).toBe(4);
    expect((await queue(f, { filter: { category: "interested" } })).total).toBe(0);
    expect((await workQueue.getWorkQueueCounts(deps, f.actor)).total).toBe(4);
  });

  it("lists each group oldest first by the time its item started to wait", async () => {
    const f = await fixture();
    const inbound = (recordId: string, iso: string) => sql`update records set last_inbound_at = ${iso}, last_interaction_at = ${iso} where id = ${recordId}`;

    // next_step: the last inbound message decides.
    const n1 = await lead(f);
    const n2 = await lead(f);
    const n3 = await lead(f);
    await inbound(n1.recordId, "2026-10-10T09:00:00Z");
    await inbound(n2.recordId, "2026-10-12T09:00:00Z");
    await inbound(n3.recordId, "2026-10-11T09:00:00Z");

    // reply: writing the draft again later does not move the item, because the person waits since their message.
    const r1 = await lead(f);
    const r2 = await lead(f);
    await inbound(r1.recordId, "2026-10-08T09:00:00Z");
    await inbound(r2.recordId, "2026-10-07T09:00:00Z");
    await draft(f, r1);
    const olderDraft = await draft(f, r2);
    await sql`update drafts set status = 'stale' where id = ${olderDraft}`;
    await draft(f, r2);
    await sql`update drafts set updated_at = now() where record_id = ${r2.recordId}`;

    // follow_up: the most overdue comes first.
    const u1 = await lead(f);
    const u2 = await lead(f);
    await sql`update records set workflow_state = 'waiting', next_action_at = '2026-10-05T00:00:00Z' where id = ${u1.recordId}`;
    await sql`update records set workflow_state = 'waiting', next_action_at = '2026-10-01T00:00:00Z' where id = ${u2.recordId}`;

    // problem: the failure time decides.
    const p1 = await lead(f);
    const p2 = await lead(f);
    const failedLater = await draft(f, p1, "failed", "Body is empty");
    const failedEarlier = await draft(f, p2, "failed", "Body is empty");
    await sql`update drafts set updated_at = '2026-10-15T09:00:00Z' where id = ${failedLater}`;
    await sql`update drafts set updated_at = '2026-10-13T09:00:00Z' where id = ${failedEarlier}`;

    const q = await queue(f);
    expect(ids(q.groups.next_step)).toEqual([n1.recordId, n3.recordId, n2.recordId]);
    expect(ids(q.groups.reply)).toEqual([r2.recordId, r1.recordId]);
    expect(ids(q.groups.follow_up)).toEqual([u2.recordId, u1.recordId]);
    expect(ids(q.groups.problem)).toEqual([p2.recordId, p1.recordId]);
    expect(q.groups.next_step.items[0].waitingSince).toEqual({ at: new Date("2026-10-10T09:00:00Z"), basis: "inbound" });
    expect(q.groups.follow_up.items[0].waitingSince).toEqual({ at: new Date("2026-10-01T00:00:00Z"), basis: "due" });
    expect(q.groups.problem.items[0].waitingSince).toEqual({ at: new Date("2026-10-13T09:00:00Z"), basis: "failure" });

    // The oldest figure covers replies, classifications, next steps and problems. The follow-up due on Oct 1 is left out.
    const counts = await workQueue.getWorkQueueCounts(deps, f.actor);
    expect(counts.oldestWaiting.unassigned).toEqual(new Date("2026-10-07T09:00:00Z"));
    expect(counts.oldestWaiting.mine).toBeNull();
    expect(counts.oldestWaiting.others).toBeNull();
  });

  it("pages oldest first with no gap or repeat when the times differ", async () => {
    const f = await fixture();
    const made: Array<{ recordId: string; at: number }> = [];
    // Created out of order on purpose: the list must follow the waiting time, not the creation order.
    for (const minute of [30, 5, 55, 12, 41, 0, 23, 48, 17, 36, 9, 59, 2, 27, 44, 51, 14, 33, 7, 19]) {
      const l = await lead(f);
      await draft(f, l);
      const at = Date.UTC(2026, 9, 10, 9, minute);
      await sql`update records set last_inbound_at = ${new Date(at).toISOString()} where id = ${l.recordId}`;
      made.push({ recordId: l.recordId, at });
    }
    const expected = made.sort((a, b) => a.at - b.at).map((m) => m.recordId);

    const seen: string[] = [];
    let page = await queue(f, { limit: 6, filter: { group: "reply" } });
    seen.push(...ids(page.groups.reply));
    while (page.groups.reply.nextCursor) {
      page = await queue(f, { limit: 6, filter: { group: "reply" }, cursor: page.groups.reply.nextCursor });
      seen.push(...ids(page.groups.reply));
    }
    expect(seen).toEqual(expected);
  });

  it("opens the next item in display order, and the first one left after an item is handled", async () => {
    const f = await fixture();
    const inbound = (recordId: string, iso: string) => sql`update records set last_inbound_at = ${iso} where id = ${recordId}`;
    const r1 = await lead(f);
    const r2 = await lead(f);
    const r3 = await lead(f);
    for (const [l, iso] of [[r1, "2026-10-08T09:00:00Z"], [r2, "2026-10-09T09:00:00Z"], [r3, "2026-10-10T09:00:00Z"]] as const) {
      await draft(f, l);
      await inbound(l.recordId, iso);
    }
    const due = await lead(f);
    await sql`update records set workflow_state = 'waiting', next_action_at = now() - interval '1 hour' where id = ${due.recordId}`;
    const next = async (recordId: string, filter?: Record<string, unknown>) => (await workQueue.getNextQueueItem(deps, f.actor, { recordId, filter }))?.recordId ?? null;

    // Display order: replies oldest first, then follow-ups.
    expect(await next(r1.recordId)).toBe(r2.recordId);
    expect(await next(r2.recordId)).toBe(r3.recordId);
    expect(await next(r3.recordId)).toBe(due.recordId);
    expect(await next(due.recordId)).toBe(r1.recordId);
    // The same filter the person came from narrows the answer.
    expect(await next(r1.recordId, { group: "reply" })).toBe(r2.recordId);
    expect(await next(r3.recordId, { group: "reply" })).toBe(r1.recordId);

    // Approving a draft moves the record to waiting with no due time; it leaves the queue, and the first item left is next.
    await sql`update drafts set status = 'sent' where record_id = ${r1.recordId}`;
    await sql`update records set workflow_state = 'waiting', next_action_at = now() + interval '3 days' where id = ${r1.recordId}`;
    expect(await next(r1.recordId)).toBe(r2.recordId);

    await expect(workQueue.getNextQueueItem(deps, f.actor, { recordId: "not-an-id" })).rejects.toThrow(NotFoundError);
    // Another organization's record id is just an id that is not in this queue: the first item here is returned, never theirs.
    const other = await fixture();
    const foreign = await lead(other);
    expect(await next(foreign.recordId)).toBe(r2.recordId);
  });

  it("finds the next item of a group deeper than the page maximum", async () => {
    const f = await fixture();
    const made: string[] = [];
    // 205 records that need a next step, created in order, waiting one minute apart: more than one page of the maximum size.
    for (let i = 0; i < 205; i += 1) made.push((await lead(f)).recordId);
    await sql`
      update records r set last_inbound_at = '2026-10-01T00:00:00Z'::timestamptz + (o.n * interval '1 minute')
      from (select id, row_number() over (order by created_at, id) as n from records where organization_id = ${f.org}) o where r.id = o.id`;
    const ordered = (await sql`select id from records where organization_id = ${f.org} order by last_inbound_at, id`).map((r) => r.id as string);
    expect(ordered).toHaveLength(205);
    const next = async (recordId: string) => (await workQueue.getNextQueueItem(deps, f.actor, { recordId }))?.recordId ?? null;

    // Past the first 200 the old window did not hold the record, and the answer jumped back to the top.
    expect(await next(ordered[201])).toBe(ordered[202]);
    expect(await next(ordered[203])).toBe(ordered[204]);
    // The last item wraps to the first.
    expect(await next(ordered[204])).toBe(ordered[0]);
    expect(await next(ordered[0])).toBe(ordered[1]);
  }, 60_000);

  it("reads a bare due date in the organization's time zone", async () => {
    const f = await fixture();
    await sql`update organizations set timezone = 'Asia/Seoul' where id = ${f.org}`;
    // 2026-10-15 16:00 UTC is 2026-10-16 01:00 in Seoul.
    const l = await lead(f);
    await sql`update records set workflow_state = 'waiting', next_action_at = '2026-10-15T16:00:00Z' where id = ${l.recordId}`;
    const deps2 = (await import("../work-queue-composition")).workQueueDeps();
    const due = async (filter: Record<string, string>) => (await workQueue.getWorkQueue(deps2, f.actor, { filter })).groups.follow_up.items.map((i) => i.recordId);

    expect(await due({ dueBefore: "2026-10-15" })).toEqual([]);
    expect(await due({ dueBefore: "2026-10-16" })).toEqual([l.recordId]);
    expect(await due({ dueAfter: "2026-10-16" })).toEqual([l.recordId]);
    expect(await due({ dueAfter: "2026-10-17" })).toEqual([]);

    // The same record under a UTC organization is still due on Oct 15.
    const utc = await fixture();
    const same = await lead(utc);
    await sql`update records set workflow_state = 'waiting', next_action_at = '2026-10-15T16:00:00Z' where id = ${same.recordId}`;
    expect((await workQueue.getWorkQueue(deps2, utc.actor, { filter: { dueBefore: "2026-10-15" } })).groups.follow_up.items.map((i) => i.recordId)).toEqual([same.recordId]);
  });

  it("shows the start of the latest inbound message of the thread the item opens, and never a private thread", async () => {
    const f = await fixture();
    const long = `Hello there.\n\n   ${"We would like a demo of the product. ".repeat(10)}`;
    const l = await lead(f, { bodyText: long });
    await draft(f, l);
    const item = (await queue(f)).groups.reply.items[0];
    expect(item.snippet).toHaveLength(140);
    expect(item.snippet).toMatch(/^Hello there\. We would like a demo/);
    expect(item.snippet).not.toMatch(/\s\s|\n/);

    // A newer message in a personal campaign's thread is private to it. The snippet stays with the public thread.
    const [{ id: campaignId }] = await sql`insert into campaigns (organization_id, name, channel, type) values (${f.org}, 'Personal', 'linkedin', 'personal') returning id`;
    const [{ id: privateConversation }] = await sql`insert into conversations (organization_id, record_id, channel, account_ref, private_campaign_id) values (${f.org}, ${l.recordId}, 'linkedin', ${"acct-" + f.tag}, ${campaignId}) returning id`;
    await sql`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
      values (${f.org}, ${privateConversation}, 'linkedin', ${"acct-" + f.tag}, 'inbound', ${"private-" + f.tag}, 'PRIVATE words that no one else may read', now())`;
    const after = (await queue(f)).groups.reply.items[0];
    expect(after.snippet).toMatch(/^Hello there\./);
    expect(JSON.stringify(after)).not.toContain("PRIVATE");
  });

  it("shows the start of the draft a reply row asks you to approve, the edited text when a person changed it, on one line", async () => {
    const f = await fixture();
    const l = await lead(f);
    const id = await draft(f, l);
    await sql`update drafts set ai_body_text = ${"Hi Rae,\n\n   Thanks for getting back to us. " + "More words. ".repeat(30)} where id = ${id}`;
    const first = (await queue(f)).groups.reply.items[0];
    expect(first.draft?.preview).toHaveLength(140);
    expect(first.draft?.preview).toMatch(/^Hi Rae, Thanks for getting back to us\./);
    expect(first.draft?.preview).not.toMatch(/\s\s|\n/);

    await sql`update drafts set edited_body_text = 'Hello Rae, a person rewrote this.' where id = ${id}`;
    expect((await queue(f)).groups.reply.items[0].draft?.preview).toBe("Hello Rae, a person rewrote this.");

    // A draft with no text has no preview, and a page of the queue still loads.
    await sql`update drafts set ai_body_text = null, edited_body_text = null where id = ${id}`;
    expect((await queue(f)).groups.reply.items[0].draft?.preview).toBeNull();
  });

  it("returns no oldest figure when only follow-ups are due", async () => {
    const f = await fixture();
    const due = await lead(f);
    await sql`update records set workflow_state = 'waiting', next_action_at = now() - interval '2 days' where id = ${due.recordId}`;
    const counts = await workQueue.getWorkQueueCounts(deps, f.actor);
    expect(counts.total).toBe(1);
    expect(counts.oldestWaiting).toEqual({ mine: null, unassigned: null, others: null });
  });

  it("puts every record in the group, or out of the queue, that the domain rule says", async () => {
    const f = await fixture();
    const hour = 60 * 60 * 1000;
    const scenarios: Array<{ name: string } & Partial<QueueFacts>> = [
      { name: "bare action_required" },
      { name: "open task", hasOpenTask: true },
      { name: "draft to review", hasDraftToReview: true },
      { name: "draft to review and an open task", hasDraftToReview: true, hasOpenTask: true },
      { name: "failed draft", hasProblemDraft: true },
      { name: "failed draft and a draft to review", hasProblemDraft: true, hasDraftToReview: true },
      { name: "held classification", hasClassificationToReview: true },
      { name: "held classification and a draft to review", hasClassificationToReview: true, hasDraftToReview: true },
      { name: "held classification and an open task", hasClassificationToReview: true, hasOpenTask: true },
      { name: "failed job", hasFailedJob: true },
      { name: "failed job and a draft to review", hasFailedJob: true, hasDraftToReview: true },
      { name: "error", workflowState: "error" },
      { name: "error and a draft to review", workflowState: "error", hasDraftToReview: true },
      { name: "error and an open task", workflowState: "error", hasOpenTask: true },
      { name: "waiting and due", workflowState: "waiting", nextActionAt: new Date(Date.now() - hour) },
      { name: "waiting and due, open task", workflowState: "waiting", nextActionAt: new Date(Date.now() - hour), hasOpenTask: true },
      { name: "waiting and due, draft to review", workflowState: "waiting", nextActionAt: new Date(Date.now() - hour), hasDraftToReview: true },
      { name: "waiting, not due", workflowState: "waiting", nextActionAt: new Date(Date.now() + 24 * hour) },
      { name: "waiting, no time", workflowState: "waiting" },
      { name: "idle with a draft to review", workflowState: "idle", hasDraftToReview: true },
      { name: "idle with a failed draft", workflowState: "idle", hasProblemDraft: true },
      { name: "closed", workflowState: "closed" },
      { name: "paused", workflowState: "paused" },
    ];

    const built: Array<{ name: string; recordId: string; facts: QueueFacts }> = [];
    for (const { name, ...partial } of scenarios) {
      const facts: QueueFacts = {
        workflowState: "action_required",
        nextActionAt: null,
        hasProblemDraft: false,
        hasFailedJob: false,
        hasDraftToReview: false,
        hasClassificationToReview: false,
        hasOpenTask: false,
        ...partial,
      };
      const l = await lead(f);
      await sql`update records set workflow_state = ${facts.workflowState}, next_action_at = ${facts.nextActionAt?.toISOString() ?? null} where id = ${l.recordId}`;
      if (facts.hasProblemDraft) await draft(f, l, "failed", "Body is empty");
      if (facts.hasDraftToReview) await draft(f, l);
      if (facts.hasClassificationToReview) await classification(f, l, "proposed");
      if (facts.hasFailedJob) {
        const r = await rec(l.recordId);
        await sql`
          insert into ai_jobs (organization_id, kind, entity_type, entity_id, idempotency_key, status, attempts, failed_at, last_error)
          values (${f.org}, 'classification', 'message', ${r.latest_inbound_message_id}, ${"k-" + r.latest_inbound_message_id}, 'failed', 3, now(), 'Provider timeout')`;
      }
      if (facts.hasOpenTask) await sql`insert into tasks (organization_id, person_id, record_id, name) values (${f.org}, ${l.personId}, ${l.recordId}, 'Call')`;
      built.push({ name, recordId: l.recordId, facts });
    }

    const q = await queue(f, { limit: 200 });
    const groupOf = new Map<string, QueueGroup>();
    for (const [group, page] of Object.entries(q.groups) as Array<[QueueGroup, (typeof q.groups)[QueueGroup]]>) {
      for (const item of page.items) groupOf.set(item.recordId, group);
    }
    const now = new Date();
    const actual = built.map((b) => [b.name, groupOf.get(b.recordId) ?? null]);
    const expected = built.map((b) => [b.name, isInQueue(b.facts, now) ? queueGroupOf(b.facts) : null]);
    expect(actual).toEqual(expected);
    expect(q.total).toBe(expected.filter(([, group]) => group !== null).length);

    // The clock of every listed item is the one `waitingSince` gives for the same facts.
    const items = new Map(Object.values(q.groups).flatMap((page) => page.items.map((item) => [item.recordId, item] as const)));
    for (const b of built) {
      const item = items.get(b.recordId);
      if (!item) continue;
      const r = await rec(b.recordId);
      const [failedDraft] = await sql`select updated_at from drafts where record_id = ${b.recordId} and status in ('failed', 'delivery_uncertain')`;
      const [failedJob] = await sql`select failed_at from ai_jobs where organization_id = ${f.org} and status = 'failed' and entity_id = ${r.latest_inbound_message_id}`;
      const expectedClock = waitingSince(queueGroupOf(b.facts), {
        lastInboundAt: r.last_inbound_at,
        lastInteractionAt: r.last_interaction_at,
        createdAt: r.created_at,
        nextActionAt: r.next_action_at,
        failedAt: failedDraft?.updated_at ?? failedJob?.failed_at ?? r.updated_at,
      });
      expect([b.name, item.waitingSince]).toEqual([b.name, expectedClock]);
    }
  });
});
