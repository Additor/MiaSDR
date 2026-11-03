import { afterAll, beforeAll, expect, it } from "vitest";
import { encodeQueueCursor, isInQueue, pickReviewOf, queueGroupOf, waitingSince, type PickReviewFacts, type QueueFacts, type QueueGroup } from "../../domain/action-queue";
import type { InboundEmailInput } from "../../../application/ports";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("Actions queue: state-based groups, filters, keyset paging, counts", () => {
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

  /** A reply from a new lead: the conversation is `action_required` with nothing attached. */
  async function lead(f: Fx, partial: Partial<InboundEmailInput> = {}) {
    const result = await composition.ingestInbound(mail(f, partial));
    const [conversation] = await sql`select * from conversations where person_id = ${result.personId}`;
    return { ...result, conversationId: conversation.id as string };
  }

  const rec = async (conversationId: string) => (await sql`select * from conversations where id = ${conversationId}`)[0];

  /** A classification job that failed for good on the conversation's latest reply: a problem in the queue. */
  async function failedJob(f: Fx, l: { conversationId: string }) {
    const [r] = await sql`select latest_inbound_message_id as message from conversations where id = ${l.conversationId}`;
    await sql`
      insert into ai_jobs (organization_id, kind, entity_type, entity_id, idempotency_key, status, attempts, failed_at, last_error)
      values (${f.org}, 'classification', 'message', ${r.message}, ${"k-failed-" + r.message}, 'failed', 3, now(), 'Provider timeout')`;
  }

  async function draft(f: Fx, l: { conversationId: string; threadId: string }, status = "awaiting_review", error: string | null = null) {
    const r = await rec(l.conversationId);
    const [d] = await sql`
      insert into drafts (organization_id, conversation_id, thread_id, expected_context_version, channel, subject, ai_body_text, status, error)
      values (${f.org}, ${l.conversationId}, ${l.threadId}, ${r.context_version}, 'email', 'Re: hello', 'Sure.', ${status}, ${error}) returning id`;
    return d.id as string;
  }

  async function insertPick(f: Fx, l: { conversationId: string }, status = "auto_applied") {
    const [target] = await sql`select id, group_key from reply_types where organization_id = ${f.org} and key = 'demo_request'`;
    const r = await rec(l.conversationId);
    const [c] = await sql`
      insert into reply_type_picks (organization_id, conversation_id, message_id, expected_context_version, previous_group_key, previous_reply_type_id,
        proposed_group_key, proposed_reply_type_id, applied_group_key, applied_reply_type_id, confidence, reasoning, status, provider)
      values (${f.org}, ${l.conversationId}, ${r.latest_inbound_message_id}, ${r.context_version}, null, null,
        ${target.group_key}, ${target.id}, ${status === "proposed" ? null : target.group_key}, ${status === "proposed" ? null : target.id}, 0.9, 'asked for a demo', ${status}, 'fake') returning id`;
    return c.id as string;
  }

  /**
   * An AI pick of the latest reply with the parts `pickReviewOf` reads. An applied pick also sets the conversation's type, as the
   * apply path does. `rules` is the snapshot's Check, or null for a pick written before snapshots.
   */
  async function aiPick(
    f: Fx,
    l: { conversationId: string },
    input: { status: "proposed" | "auto_applied"; key?: string; stopRequested?: boolean },
  ) {
    const [target] = await sql`select id, group_key from reply_types where organization_id = ${f.org} and key = ${input.key ?? "demo_request"}`;
    const r = await rec(l.conversationId);
    const applied = input.status === "auto_applied";
    await sql`
      insert into reply_type_picks (organization_id, conversation_id, message_id, expected_context_version, proposed_group_key, proposed_reply_type_id,
        applied_group_key, applied_reply_type_id, confidence, reasoning, status, provider, rules, response)
      values (${f.org}, ${l.conversationId}, ${r.latest_inbound_message_id}, ${r.context_version}, ${target.group_key}, ${target.id},
        ${applied ? target.group_key : null}, ${applied ? target.id : null}, 0.8, 'read it', ${input.status}, 'fake', ${sql.json({ replyDraft: true, followUps: "continue" })},
        ${sql.json({ stopRequested: input.stopRequested === true })})`;
    if (applied) await sql`update conversations set reply_type_id = ${target.id}, group_key = ${target.group_key}, reply_type_source = 'ai' where id = ${l.conversationId}`;
  }

  const queue = (f: Fx, input: Parameters<typeof workQueue.getWorkQueue>[2] = {}) => workQueue.getWorkQueue(deps, f.actor, input);
  const ids = (page: { items: Array<{ conversationId: string }> }) => page.items.map((i) => i.conversationId);

  beforeAll(async () => {
    composition = await import("../../../infrastructure/composition");
    workQueue = await import("../../application/work-queue");
    deps = (await import("../work-queue-composition")).workQueueDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("lists an action_required record that has no draft, AI pick or task as next_step", async () => {
    const f = await fixture();
    const l = await lead(f);
    const q = await queue(f);
    expect(q.groups.next_step.items).toMatchObject([{ conversationId: l.conversationId, group: "next_step", workflowState: "action_required", draft: null, aiPick: null, problem: null }]);
    expect(q.total).toBe(1);

    // An open task already puts the conversation in front of a person, so it leaves next_step. A done task does not.
    const [task] = await sql`insert into tasks (organization_id, person_id, conversation_id, name) values (${f.org}, ${l.personId}, ${l.conversationId}, 'Call') returning id`;
    expect((await queue(f)).groups.next_step.total).toBe(0);
    await sql`update tasks set is_completed = true, completed_at = now() where id = ${task.id}`;
    expect((await queue(f)).groups.next_step.total).toBe(1);
  });

  it("puts each record in one group, problem first, and leaves idle and not-yet-due records out", async () => {
    const f = await fixture();
    const reply = await lead(f);
    await draft(f, reply);
    const review = await lead(f);
    await insertPick(f, review, "proposed");
    const both = await lead(f);
    await draft(f, both);
    await draft(f, both, "failed", "Body is empty");
    const due = await lead(f);
    await sql`update conversations set workflow_state = 'waiting', next_action_at = now() - interval '1 hour' where id = ${due.conversationId}`;
    const notDue = await lead(f);
    await sql`update conversations set workflow_state = 'waiting', next_action_at = now() + interval '3 days' where id = ${notDue.conversationId}`;
    const idle = await lead(f);
    await sql`update conversations set workflow_state = 'idle' where id = ${idle.conversationId}`;
    const closed = await lead(f);
    await sql`update conversations set workflow_state = 'closed' where id = ${closed.conversationId}`;
    const errored = await lead(f);
    await failedJob(f, errored);

    const q = await queue(f);
    expect(ids(q.groups.reply)).toEqual([reply.conversationId]);
    expect(q.groups.ai_pick.items).toMatchObject([{ conversationId: review.conversationId, aiPick: { kind: "held", name: "Demo request" } }]);
    expect(ids(q.groups.follow_up)).toEqual([due.conversationId]);
    expect(ids(q.groups.problem).sort()).toEqual([both.conversationId, errored.conversationId].sort());
    expect(q.groups.problem.items.find((i) => i.conversationId === both.conversationId)?.problem).toMatchObject({ kind: "draft_failed", message: "Body is empty" });
    expect(q.groups.problem.items.find((i) => i.conversationId === errored.conversationId)?.problem?.kind).toBe("job_failed");
    expect(q.groups.next_step.total).toBe(0);
    expect(q.total).toBe(5);
  });

  it("shows a failed draft job, an unconfirmed reply and a failed classification job as problems", async () => {
    const f = await fixture();
    const failedDraftJob = await lead(f);
    const replyTypePickId = await insertPick(f, failedDraftJob);
    await sql`
      insert into ai_jobs (organization_id, kind, entity_type, entity_id, idempotency_key, status, attempts, failed_at, last_error)
      values (${f.org}, 'initial_draft', 'classification', ${replyTypePickId}, ${"k-" + replyTypePickId}, 'failed', 3, now(), 'Model refused the request')`;
    const failedClassify = await lead(f);
    const r = await rec(failedClassify.conversationId);
    await sql`
      insert into ai_jobs (organization_id, kind, entity_type, entity_id, idempotency_key, status, attempts, failed_at, last_error)
      values (${f.org}, 'classification', 'message', ${r.latest_inbound_message_id}, ${"k-" + r.latest_inbound_message_id}, 'failed', 3, now(), 'Provider timeout')`;
    const uncertain = await lead(f);
    await draft(f, uncertain, "delivery_uncertain", "No reply from the mailbox");

    const q = await queue(f);
    const byConversation = new Map(q.groups.problem.items.map((i) => [i.conversationId, i.problem]));
    expect(byConversation.get(failedDraftJob.conversationId)).toEqual({ kind: "job_failed", message: "Model refused the request" });
    expect(byConversation.get(failedClassify.conversationId)).toEqual({ kind: "job_failed", message: "Provider timeout" });
    expect(byConversation.get(uncertain.conversationId)).toMatchObject({ kind: "delivery_uncertain", message: "No reply from the mailbox" });
    expect(q.groups.problem.total).toBe(3);

    // A person who writes the reply by hand clears the draft-job problem.
    await draft(f, failedDraftJob);
    const after = await queue(f);
    expect(ids(after.groups.problem)).not.toContain(failedDraftJob.conversationId);
    expect(ids(after.groups.reply)).toContain(failedDraftJob.conversationId);
  });

  it("pages 120 drafts past 50 with an exact total, no duplicates and no gaps", async () => {
    const f = await fixture();
    const expected: string[] = [];
    // The same receivedAt for every lead forces ties on the sort time, so the conversation id has to break them.
    for (let i = 0; i < 120; i++) {
      const l = await lead(f);
      await draft(f, l);
      expected.push(l.conversationId);
    }
    const first = await queue(f);
    expect(first.groups.reply.total).toBe(120);
    expect(first.groups.reply.items).toHaveLength(50);
    expect(first.groups.reply.nextCursor).not.toBeNull();

    const seen = [...ids(first.groups.reply)];
    let cursor = first.groups.reply.nextCursor;
    let pages = 1;
    while (cursor) {
      const next = await queue(f, { filter: { list: "reply" }, cursor });
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
    const small = await queue(f, { limit: 7, filter: { list: "reply" } });
    expect(small.groups.reply.items).toHaveLength(7);
    expect((await queue(f, { limit: 0 })).groups.reply.items).toHaveLength(50);
  });

  it("filters by group, channel, list, due window, reply type, campaign and errors only", async () => {
    const f = await fixture();
    const demo = await lead(f);
    const [sub] = await sql`select id, group_key from reply_types where organization_id = ${f.org} and key = 'demo_request'`;
    await sql`update conversations set group_key = ${sub.group_key}, reply_type_id = ${sub.id}, reply_type_source = 'human' where id = ${demo.conversationId}`;
    await draft(f, demo);
    const plain = await lead(f);
    const linkedin = await lead(f);
    await sql`update conversations set active_channel = 'linkedin' where id = ${linkedin.conversationId}`;
    const dueSoon = await lead(f);
    await sql`update conversations set workflow_state = 'waiting', next_action_at = '2026-10-10T00:00:00Z' where id = ${dueSoon.conversationId}`;
    const dueEarlier = await lead(f);
    await sql`update conversations set workflow_state = 'waiting', next_action_at = '2026-10-01T00:00:00Z' where id = ${dueEarlier.conversationId}`;
    const broken = await lead(f);
    await failedJob(f, broken);

    const all = (q: Awaited<ReturnType<typeof queue>>) => QUEUE_ORDER.flatMap((g) => ids(q.groups[g])).sort();
    const QUEUE_ORDER: QueueGroup[] = ["reply", "follow_up", "ai_pick", "next_step", "problem"];

    expect(all(await queue(f, { filter: { group: "interested" } }))).toEqual([demo.conversationId]);
    expect(all(await queue(f, { filter: { group: "no_type" } }))).toEqual([plain.conversationId, linkedin.conversationId, dueSoon.conversationId, dueEarlier.conversationId, broken.conversationId].sort());
    expect(all(await queue(f, { filter: { channel: "linkedin" } }))).toEqual([linkedin.conversationId]);
    expect(all(await queue(f, { filter: { replyTypeId: sub.id } }))).toEqual([demo.conversationId]);

    const typed = await queue(f, { filter: { list: "follow_up" } });
    expect(ids(typed.groups.follow_up).sort()).toEqual([dueSoon.conversationId, dueEarlier.conversationId].sort());
    expect(typed.groups.reply.items).toEqual([]);
    expect(typed.groups.reply.total).toBe(1);

    expect(all(await queue(f, { filter: { dueBefore: "2026-10-05" } }))).toEqual([dueEarlier.conversationId]);
    expect(all(await queue(f, { filter: { dueBefore: "2026-10-10" } }))).toEqual([dueSoon.conversationId, dueEarlier.conversationId].sort());
    expect(all(await queue(f, { filter: { dueAfter: "2026-10-05T00:00:00Z" } }))).toEqual([dueSoon.conversationId]);
    expect(all(await queue(f, { filter: { dueAfter: "2026-10-02", dueBefore: "2026-10-30" } }))).toEqual([dueSoon.conversationId]);

    const errors = await queue(f, { filter: { errorsOnly: "1" } });
    expect(ids(errors.groups.problem)).toEqual([broken.conversationId]);
    expect(errors.groups.reply.items).toEqual([]);

    // The campaign filter keeps the conversations of people enrolled in that campaign.
    const person = (await sql`select person_id from conversations where id = ${plain.conversationId}`)[0].person_id as string;
    const [{ id: campaign }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'email', 'Autumn', 'active') returning id`;
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${f.org}, ${campaign}, ${person}, 'email', 'replied')`;
    expect(all(await queue(f, { filter: { campaignId: campaign } }))).toEqual([plain.conversationId]);
    expect(all(await queue(f, { filter: { campaignId: "00000000-0000-4000-8000-000000000000" } }))).toEqual([]);
    await expect(queue(f, { filter: { campaignId: "not-a-uuid" } })).rejects.toThrow(ValidationError);
  });

  it("the campaign filter means people currently enrolled: active and replied match, removed does not, on both channels", async () => {
    const f = await fixture();
    const active = await lead(f);
    const replied = await lead(f);
    const removed = await lead(f);
    const stranger = await lead(f);
    const personOf = async (l: { conversationId: string }) => (await sql`select person_id from conversations where id = ${l.conversationId}`)[0].person_id as string;
    const enroll = async (campaign: string, l: { conversationId: string }, status: string, channel = "email") =>
      sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${f.org}, ${campaign}, ${await personOf(l)}, ${channel}, ${status})`;
    const [{ id: email }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'email', 'Autumn', 'active') returning id`;
    await enroll(email, active, "active");
    await enroll(email, replied, "replied");
    await enroll(email, removed, "removed");
    const matches = async (campaignId: string) => ids((await queue(f, { filter: { campaignId } })).groups.next_step).sort();
    expect(await matches(email)).toEqual([active.conversationId, replied.conversationId].sort());

    // A person removed from one campaign and still enrolled in another shows under the other only.
    const [{ id: linkedin }] = await sql`insert into campaigns (organization_id, channel, name, status) values (${f.org}, 'linkedin', 'Connect', 'active') returning id`;
    await enroll(linkedin, removed, "active", "linkedin");
    await enroll(linkedin, active, "removed", "linkedin");
    expect(await matches(linkedin)).toEqual([removed.conversationId]);
    expect(await matches(email)).toEqual([active.conversationId, replied.conversationId].sort());
    // Without the filter the queue holds the stranger too, so the filter is what leaves them out.
    expect(ids((await queue(f)).groups.next_step).sort()).toEqual([active.conversationId, replied.conversationId, removed.conversationId, stranger.conversationId].sort());
    // The totals use the same filter.
    expect((await queue(f, { filter: { campaignId: email } })).total).toBe(2);
  });

  it("rejects bad filters and cursors", async () => {
    const f = await fixture();
    await expect(queue(f, { filter: { channel: "fax" } })).rejects.toThrow(ValidationError);
    await expect(queue(f, { filter: { list: "everything" } })).rejects.toThrow(ValidationError);
    await expect(queue(f, { filter: { replyTypeId: "not-a-uuid" } })).rejects.toThrow(ValidationError);
    await expect(queue(f, { filter: { dueBefore: "soon" } })).rejects.toThrow(ValidationError);
    await expect(queue(f, { filter: { list: "reply", errorsOnly: "1" } })).rejects.toThrow(ValidationError);
    await expect(queue(f, { filter: { list: "reply" }, cursor: "garbage" })).rejects.toThrow(ValidationError);
    await expect(queue(f, { cursor: encodeQueueCursor({ sortKey: "2026-10-14 10:00:00+00", conversationId: "00000000-0000-4000-8000-000000000000" }) })).rejects.toThrow(/action type/);
    // A cursor from the newest-first order is refused instead of continued.
    await expect(queue(f, { filter: { list: "reply" }, cursor: Buffer.from(JSON.stringify(["2026-10-14 10:00:00+00", "00000000-0000-4000-8000-000000000000"])).toString("base64url") })).rejects.toThrow(/Reload the queue/);
  });

  it("keeps organizations apart", async () => {
    const a = await fixture();
    const b = await fixture();
    const la = await lead(a);
    await draft(a, la);
    const lb = await lead(b);
    expect(ids((await queue(b)).groups.reply)).toEqual([]);
    expect(ids((await queue(b)).groups.next_step)).toEqual([lb.conversationId]);
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
    await failedJob(f, l2);
    await lead(f);
    const due = await lead(f);
    await sql`update conversations set workflow_state = 'waiting', next_action_at = now() - interval '1 minute' where id = ${due.conversationId}`;

    const page = await queue(f);
    const counts = await workQueue.getWorkQueueCounts(deps, f.actor);
    expect(page.total).toBe(4);
    expect(counts.total).toBe(page.total);
    for (const g of ["reply", "follow_up", "ai_pick", "next_step", "problem"] as const) {
      expect(counts.byGroup[g]).toBe(page.groups[g].total);
    }
    // A filter narrows the page but never the badge.
    expect((await queue(f, { filter: { list: "reply" } })).total).toBe(4);
    expect((await queue(f, { filter: { group: "interested" } })).total).toBe(0);
    expect((await workQueue.getWorkQueueCounts(deps, f.actor)).total).toBe(4);
  });

  it("lists each group oldest first by the time its item started to wait", async () => {
    const f = await fixture();
    const inbound = (conversationId: string, iso: string) => sql`update conversations set last_inbound_at = ${iso}, last_interaction_at = ${iso} where id = ${conversationId}`;

    // next_step: the last inbound message decides.
    const n1 = await lead(f);
    const n2 = await lead(f);
    const n3 = await lead(f);
    await inbound(n1.conversationId, "2026-10-10T09:00:00Z");
    await inbound(n2.conversationId, "2026-10-12T09:00:00Z");
    await inbound(n3.conversationId, "2026-10-11T09:00:00Z");

    // reply: writing the draft again later does not move the item, because the person waits since their message.
    const r1 = await lead(f);
    const r2 = await lead(f);
    await inbound(r1.conversationId, "2026-10-08T09:00:00Z");
    await inbound(r2.conversationId, "2026-10-07T09:00:00Z");
    await draft(f, r1);
    const olderDraft = await draft(f, r2);
    await sql`update drafts set status = 'stale' where id = ${olderDraft}`;
    await draft(f, r2);
    await sql`update drafts set updated_at = now() where conversation_id = ${r2.conversationId}`;

    // follow_up: the most overdue comes first.
    const u1 = await lead(f);
    const u2 = await lead(f);
    await sql`update conversations set workflow_state = 'waiting', next_action_at = '2026-10-05T00:00:00Z' where id = ${u1.conversationId}`;
    await sql`update conversations set workflow_state = 'waiting', next_action_at = '2026-10-01T00:00:00Z' where id = ${u2.conversationId}`;

    // problem: the failure time decides.
    const p1 = await lead(f);
    const p2 = await lead(f);
    const failedLater = await draft(f, p1, "failed", "Body is empty");
    const failedEarlier = await draft(f, p2, "failed", "Body is empty");
    await sql`update drafts set updated_at = '2026-10-15T09:00:00Z' where id = ${failedLater}`;
    await sql`update drafts set updated_at = '2026-10-13T09:00:00Z' where id = ${failedEarlier}`;

    const q = await queue(f);
    expect(ids(q.groups.next_step)).toEqual([n1.conversationId, n3.conversationId, n2.conversationId]);
    expect(ids(q.groups.reply)).toEqual([r2.conversationId, r1.conversationId]);
    expect(ids(q.groups.follow_up)).toEqual([u2.conversationId, u1.conversationId]);
    expect(ids(q.groups.problem)).toEqual([p2.conversationId, p1.conversationId]);
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
    const made: Array<{ conversationId: string; at: number }> = [];
    // Created out of order on purpose: the list must follow the waiting time, not the creation order.
    for (const minute of [30, 5, 55, 12, 41, 0, 23, 48, 17, 36, 9, 59, 2, 27, 44, 51, 14, 33, 7, 19]) {
      const l = await lead(f);
      await draft(f, l);
      const at = Date.UTC(2026, 9, 10, 9, minute);
      await sql`update conversations set last_inbound_at = ${new Date(at).toISOString()} where id = ${l.conversationId}`;
      made.push({ conversationId: l.conversationId, at });
    }
    const expected = made.sort((a, b) => a.at - b.at).map((m) => m.conversationId);

    const seen: string[] = [];
    let page = await queue(f, { limit: 6, filter: { list: "reply" } });
    seen.push(...ids(page.groups.reply));
    while (page.groups.reply.nextCursor) {
      page = await queue(f, { limit: 6, filter: { list: "reply" }, cursor: page.groups.reply.nextCursor });
      seen.push(...ids(page.groups.reply));
    }
    expect(seen).toEqual(expected);
  });

  it("opens the next item in display order, and the first one left after an item is handled", async () => {
    const f = await fixture();
    const inbound = (conversationId: string, iso: string) => sql`update conversations set last_inbound_at = ${iso} where id = ${conversationId}`;
    const r1 = await lead(f);
    const r2 = await lead(f);
    const r3 = await lead(f);
    for (const [l, iso] of [[r1, "2026-10-08T09:00:00Z"], [r2, "2026-10-09T09:00:00Z"], [r3, "2026-10-10T09:00:00Z"]] as const) {
      await draft(f, l);
      await inbound(l.conversationId, iso);
    }
    const due = await lead(f);
    await sql`update conversations set workflow_state = 'waiting', next_action_at = now() - interval '1 hour' where id = ${due.conversationId}`;
    const next = async (conversationId: string, filter?: Record<string, unknown>) => (await workQueue.getNextQueueItem(deps, f.actor, { conversationId, filter }))?.conversationId ?? null;

    // Display order: replies oldest first, then follow-ups.
    expect(await next(r1.conversationId)).toBe(r2.conversationId);
    expect(await next(r2.conversationId)).toBe(r3.conversationId);
    expect(await next(r3.conversationId)).toBe(due.conversationId);
    expect(await next(due.conversationId)).toBe(r1.conversationId);
    // The same filter the person came from narrows the answer.
    expect(await next(r1.conversationId, { list: "reply" })).toBe(r2.conversationId);
    expect(await next(r3.conversationId, { list: "reply" })).toBe(r1.conversationId);

    // Approving a draft moves the conversation to waiting with no due time; it leaves the queue, and the first item left is next.
    await sql`update drafts set status = 'sent' where conversation_id = ${r1.conversationId}`;
    await sql`update conversations set workflow_state = 'waiting', next_action_at = now() + interval '3 days' where id = ${r1.conversationId}`;
    expect(await next(r1.conversationId)).toBe(r2.conversationId);

    await expect(workQueue.getNextQueueItem(deps, f.actor, { conversationId: "not-an-id" })).rejects.toThrow(NotFoundError);
    // Another organization's conversation id is just an id that is not in this queue: the first item here is returned, never theirs.
    const other = await fixture();
    const foreign = await lead(other);
    expect(await next(foreign.conversationId)).toBe(r2.conversationId);
  });

  it("finds the next item of a group deeper than the page maximum", async () => {
    const f = await fixture();
    const made: string[] = [];
    // 205 records that need a next step, created in order, waiting one minute apart: more than one page of the maximum size.
    for (let i = 0; i < 205; i += 1) made.push((await lead(f)).conversationId);
    await sql`
      update conversations r set last_inbound_at = '2026-10-01T00:00:00Z'::timestamptz + (o.n * interval '1 minute')
      from (select id, row_number() over (order by created_at, id) as n from conversations where organization_id = ${f.org}) o where r.id = o.id`;
    const ordered = (await sql`select id from conversations where organization_id = ${f.org} order by last_inbound_at, id`).map((r) => r.id as string);
    expect(ordered).toHaveLength(205);
    const next = async (conversationId: string) => (await workQueue.getNextQueueItem(deps, f.actor, { conversationId }))?.conversationId ?? null;

    // Past the first 200 the old window did not hold the conversation, and the answer jumped back to the top.
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
    await sql`update conversations set workflow_state = 'waiting', next_action_at = '2026-10-15T16:00:00Z' where id = ${l.conversationId}`;
    const deps2 = (await import("../work-queue-composition")).workQueueDeps();
    const due = async (filter: Record<string, string>) => (await workQueue.getWorkQueue(deps2, f.actor, { filter })).groups.follow_up.items.map((i) => i.conversationId);

    expect(await due({ dueBefore: "2026-10-15" })).toEqual([]);
    expect(await due({ dueBefore: "2026-10-16" })).toEqual([l.conversationId]);
    expect(await due({ dueAfter: "2026-10-16" })).toEqual([l.conversationId]);
    expect(await due({ dueAfter: "2026-10-17" })).toEqual([]);

    // The same conversation under a UTC organization is still due on Oct 15.
    const utc = await fixture();
    const same = await lead(utc);
    await sql`update conversations set workflow_state = 'waiting', next_action_at = '2026-10-15T16:00:00Z' where id = ${same.conversationId}`;
    expect((await workQueue.getWorkQueue(deps2, utc.actor, { filter: { dueBefore: "2026-10-15" } })).groups.follow_up.items.map((i) => i.conversationId)).toEqual([same.conversationId]);
  });

  it("shows the start of the latest inbound message of the thread the item opens", async () => {
    const f = await fixture();
    const long = `Hello there.\n\n   ${"We would like a demo of the product. ".repeat(10)}`;
    const l = await lead(f, { bodyText: long });
    await draft(f, l);
    const item = (await queue(f)).groups.reply.items[0];
    expect(item.snippet).toHaveLength(140);
    expect(item.snippet).toMatch(/^Hello there\. We would like a demo/);
    expect(item.snippet).not.toMatch(/\s\s|\n/);
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
    await sql`update conversations set workflow_state = 'waiting', next_action_at = now() - interval '2 days' where id = ${due.conversationId}`;
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
      { name: "held AI pick", hasReplyTypePickToReview: true },
      { name: "held AI pick and a draft to review", hasReplyTypePickToReview: true, hasDraftToReview: true },
      { name: "held AI pick and an open task", hasReplyTypePickToReview: true, hasOpenTask: true },
      { name: "failed job", hasFailedJob: true },
      { name: "failed job and a draft to review", hasFailedJob: true, hasDraftToReview: true },
      { name: "waiting and due", workflowState: "waiting", nextActionAt: new Date(Date.now() - hour) },
      { name: "waiting and due, open task", workflowState: "waiting", nextActionAt: new Date(Date.now() - hour), hasOpenTask: true },
      { name: "waiting and due, draft to review", workflowState: "waiting", nextActionAt: new Date(Date.now() - hour), hasDraftToReview: true },
      { name: "waiting, not due", workflowState: "waiting", nextActionAt: new Date(Date.now() + 24 * hour) },
      { name: "waiting, no time", workflowState: "waiting" },
      { name: "idle with a draft to review", workflowState: "idle", hasDraftToReview: true },
      { name: "idle with a failed draft", workflowState: "idle", hasProblemDraft: true },
      { name: "closed", workflowState: "closed" },
    ];

    const built: Array<{ name: string; conversationId: string; facts: QueueFacts }> = [];
    for (const { name, ...partial } of scenarios) {
      const facts: QueueFacts = {
        workflowState: "action_required",
        nextActionAt: null,
        hasProblemDraft: false,
        hasFailedJob: false,
        hasDraftToReview: false,
        hasReplyTypePickToReview: false,
        hasOpenTask: false,
        hasStopToReview: false,
        ...partial,
      };
      const l = await lead(f);
      await sql`update conversations set workflow_state = ${facts.workflowState}, next_action_at = ${facts.nextActionAt?.toISOString() ?? null} where id = ${l.conversationId}`;
      if (facts.hasProblemDraft) await draft(f, l, "failed", "Body is empty");
      if (facts.hasDraftToReview) await draft(f, l);
      if (facts.hasReplyTypePickToReview) await insertPick(f, l, "proposed");
      if (facts.hasFailedJob) {
        const r = await rec(l.conversationId);
        await sql`
          insert into ai_jobs (organization_id, kind, entity_type, entity_id, idempotency_key, status, attempts, failed_at, last_error)
          values (${f.org}, 'classification', 'message', ${r.latest_inbound_message_id}, ${"k-" + r.latest_inbound_message_id}, 'failed', 3, now(), 'Provider timeout')`;
      }
      if (facts.hasOpenTask) await sql`insert into tasks (organization_id, person_id, conversation_id, name) values (${f.org}, ${l.personId}, ${l.conversationId}, 'Call')`;
      built.push({ name, conversationId: l.conversationId, facts });
    }

    const q = await queue(f, { limit: 200 });
    const groupOf = new Map<string, QueueGroup>();
    for (const [group, page] of Object.entries(q.groups) as Array<[QueueGroup, (typeof q.groups)[QueueGroup]]>) {
      for (const item of page.items) groupOf.set(item.conversationId, group);
    }
    const now = new Date();
    const actual = built.map((b) => [b.name, groupOf.get(b.conversationId) ?? null]);
    const expected = built.map((b) => [b.name, isInQueue(b.facts, now) ? queueGroupOf(b.facts) : null]);
    expect(actual).toEqual(expected);
    expect(q.total).toBe(expected.filter(([, group]) => group !== null).length);

    // The clock of every listed item is the one `waitingSince` gives for the same facts.
    const items = new Map(Object.values(q.groups).flatMap((page) => page.items.map((item) => [item.conversationId, item] as const)));
    for (const b of built) {
      const item = items.get(b.conversationId);
      if (!item) continue;
      const r = await rec(b.conversationId);
      const [failedDraft] = await sql`select updated_at from drafts where conversation_id = ${b.conversationId} and status in ('failed', 'delivery_uncertain')`;
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

  it("lists an AI pick by what it waits for, as pickReviewOf says, and drops one that nothing waits on", async () => {
    const f = await fixture();
    const base: PickReviewFacts = {
      status: "proposed",
      current: true,
      hasProposedType: true,
      proposedSystemRole: null,
      stopReviewOpen: false,
      stopped: false,
    };
    const applied = { ...base, status: "auto_applied" };
    type L = Awaited<ReturnType<typeof lead>>;
    const dnc = (l: L) => sql`insert into contact_policies (person_id, organization_id, do_not_contact, reason, source, set_at) values (${l.personId}, ${f.org}, true, 'Asked to stop', 'human', now())`;
    const suppress = async (l: L) => {
      const [p] = await sql`select email from people where id = ${l.personId}`;
      await sql`insert into suppression_list (organization_id, email, reason) values (${f.org}, ${String(p.email).toLowerCase()}, 'manual')`;
    };
    const scenarios: Array<{ name: string; facts: PickReviewFacts; setup: (l: L) => Promise<unknown> }> = [
      { name: "held", facts: base, setup: (l) => aiPick(f, l, { status: "proposed" }) },
      {
        name: "held, record version moved on",
        facts: { ...base, current: false },
        setup: async (l) => {
          await aiPick(f, l, { status: "proposed" });
          await sql`update conversations set context_version = context_version + 1 where id = ${l.conversationId}`;
        },
      },
      { name: "held stop request", facts: { ...base, proposedSystemRole: "stop_request", stopReviewOpen: true }, setup: (l) => aiPick(f, l, { status: "proposed", key: "do_not_contact" }) },
      {
        name: "held stop request, record version moved on",
        facts: { ...base, current: false, proposedSystemRole: "stop_request", stopReviewOpen: true },
        setup: async (l) => {
          await aiPick(f, l, { status: "proposed", key: "do_not_contact" });
          await sql`update conversations set context_version = context_version + 1 where id = ${l.conversationId}`;
        },
      },
      {
        name: "held stop request, person do not contact",
        facts: { ...base, proposedSystemRole: "stop_request", stopReviewOpen: true, stopped: true },
        setup: async (l) => {
          await aiPick(f, l, { status: "proposed", key: "do_not_contact" });
          await dnc(l);
        },
      },
      {
        name: "held stop request, address suppressed",
        facts: { ...base, proposedSystemRole: "stop_request", stopReviewOpen: true, stopped: true },
        setup: async (l) => {
          await aiPick(f, l, { status: "proposed", key: "do_not_contact" });
          await suppress(l);
        },
      },
      { name: "held, reply reads as a stop", facts: { ...base, stopReviewOpen: true }, setup: (l) => aiPick(f, l, { status: "proposed", stopRequested: true }) },
      { name: "applied", facts: applied, setup: (l) => aiPick(f, l, { status: "auto_applied" }) },
      {
        name: "applied, a person reviewed the stop",
        facts: applied,
        setup: async (l) => {
          await aiPick(f, l, { status: "auto_applied", stopRequested: true });
          const r = await rec(l.conversationId);
          await sql`insert into stop_reviews (organization_id, message_id, reviewed_at) values (${f.org}, ${r.latest_inbound_message_id}, now())`;
        },
      },
      { name: "applied, reply reads as a stop", facts: { ...applied, stopReviewOpen: true }, setup: (l) => aiPick(f, l, { status: "auto_applied", stopRequested: true }) },
    ];

    const built: Array<{ name: string; conversationId: string; facts: PickReviewFacts }> = [];
    for (const { name, facts, setup } of scenarios) {
      const l = await lead(f);
      await setup(l);
      built.push({ name, conversationId: l.conversationId, facts });
    }

    const q = await queue(f, { limit: 200 });
    const items = new Map(Object.values(q.groups).flatMap((page) => page.items.map((item) => [item.conversationId, item] as const)));
    const actual = built.map((b) => [b.name, items.get(b.conversationId)?.group ?? null, items.get(b.conversationId)?.aiPick?.kind ?? null]);
    // Every conversation here is action_required, so one that nothing waits on is a next step.
    const expected = built.map((b) => {
      const kind = pickReviewOf(b.facts);
      return [b.name, kind ? "ai_pick" : "next_step", kind];
    });
    expect(actual).toEqual(expected);
    // A stop request that refuses agents stays listed when the conversation waits on nobody.
    const idle = await lead(f);
    await aiPick(f, idle, { status: "auto_applied", stopRequested: true });
    await sql`update conversations set workflow_state = 'idle' where id = ${idle.conversationId}`;
    const listed = await queue(f, { limit: 200 });
    expect(ids(listed.groups.ai_pick)).toContain(idle.conversationId);
    // The cases the brief names, spelled out.
    expect(Object.fromEntries(expected.map(([name, , kind]) => [name, kind]))).toMatchObject({
      held: "held",
      "held, record version moved on": null,
      "held stop request": "stop_review",
      "held stop request, record version moved on": "stop_review",
      "held stop request, person do not contact": null,
      "held stop request, address suppressed": null,
      applied: null,
      "applied, reply reads as a stop": "stop_review",
    });
  });

  it("lists a stop request no pick has read, and a person's review ends it", async () => {
    const f = await fixture();
    const asked = await lead(f, { bodyText: "Please unsubscribe me." });
    const quiet = await lead(f, { bodyText: "Tell me more." });
    await sql`update conversations set workflow_state = 'idle' where id in (${asked.conversationId}, ${quiet.conversationId})`;

    const listed = await queue(f, { limit: 200 });
    const row = listed.groups.ai_pick.items.find((i) => i.conversationId === asked.conversationId);
    expect(row?.aiPick).toMatchObject({ kind: "stop_review", replyTypePickId: null });
    expect(ids(listed.groups.ai_pick)).not.toContain(quiet.conversationId);

    const details = (await import("../../../infrastructure/reply-handling-composition")).replyHandlingDeps();
    const { getConversationDetail } = await import("../../../application/reply-handling");
    expect((await getConversationDetail(details, f.actor, asked.conversationId)).conversation.stopReviewOpen).toBe(true);
    expect((await getConversationDetail(details, f.actor, quiet.conversationId)).conversation.stopReviewOpen).toBe(false);

    const [r] = await sql`select latest_inbound_message_id from conversations where id = ${asked.conversationId}`;
    await sql`insert into stop_reviews (organization_id, message_id, reviewed_at) values (${f.org}, ${r.latest_inbound_message_id}, now())`;
    const reviewed = await queue(f, { limit: 200 });
    expect(ids(reviewed.groups.ai_pick)).not.toContain(asked.conversationId);
    expect((await getConversationDetail(details, f.actor, asked.conversationId)).conversation.stopReviewOpen).toBe(false);
  });
});
