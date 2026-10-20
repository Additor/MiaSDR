import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InboundLinkedInInput } from "../../../application/linkedin-ports";
import type { InboundEmailInput } from "../../../application/ports";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { describeDb, dropOrgs, testSql, uniqueKey, useTestEnv, waitForLockWaiters } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("who handles a reply: automatic assignment on the first inbound message", () => {
  useTestEnv({ MAILBOX_PROVIDER: "fake" });
  const sql = testSql({ max: 4 });
  let composition: typeof import("../../../infrastructure/composition");
  let assignment: typeof import("../../application/assignment");
  let deps: import("../../application/assignment").AssignmentDeps;
  let workQueue: typeof import("../../application/work-queue");
  let queueDeps: import("../../application/work-queue").WorkQueueDeps;
  const orgs: string[] = [];
  const users: string[] = [];
  let counter = 0;

  async function user(label: string): Promise<string> {
    const [row] = await sql`insert into users (name, email) values (${label}, ${`${label.toLowerCase()}-${uniqueKey()}@x.test`}) returning id`;
    users.push(row.id as string);
    return row.id as string;
  }

  async function fixture() {
    const tag = uniqueKey();
    const [{ id: org }] = await sql`insert into organizations (name, slug) values ('Assign', ${"as-" + tag}) returning id`;
    orgs.push(org);
    const ann = await user("Ann");
    const bob = await user("Bob");
    const carl = await user("Carl");
    // Ann and Bob are members. Carl is not.
    await sql`insert into members (organization_id, user_id, role) values (${org}, ${ann}, 'owner'), (${org}, ${bob}, 'member')`;
    return { org, ann, bob, carl, mailbox: `me-${tag}@corp.test`, account: `acct-${tag}`, tag };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;

  async function campaign(f: Fx, createdBy: string | null, opts: { type?: string; channel?: string } = {}): Promise<string> {
    const type = opts.type ?? "regular";
    const channel = opts.channel ?? (type === "personal" ? "linkedin" : "email");
    const [row] = await sql`insert into campaigns (organization_id, name, channel, type, created_by, steps) values (${f.org}, ${"c-" + ++counter}, ${channel}, ${type}, ${createdBy}, ${sql.json([])}) returning id`;
    return row.id as string;
  }

  async function enroll(f: Fx, campaignId: string, personId: string, createdAt: string, status = "active", channel = "email") {
    await sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, created_at) values (${f.org}, ${campaignId}, ${personId}, ${channel}, ${status}, ${createdAt})`;
  }

  /** A lead who exists before they write, as one in a campaign does. */
  async function enrolledLead(f: Fx) {
    const email = `lead${++counter}-${f.tag}@acme.test`;
    const [row] = await sql`insert into people (organization_id, email, full_name) values (${f.org}, ${email}, 'Lead') returning id`;
    return { personId: row.id as string, email };
  }

  const mail = (f: Fx, from: string, partial: Partial<InboundEmailInput> = {}): InboundEmailInput => {
    const n = ++counter;
    return {
      organizationId: f.org,
      accountRef: f.mailbox,
      providerThreadId: `thread-${n}`,
      providerMessageId: `msg-${n}`,
      rfcMessageId: `<m${n}@lead.test>`,
      inReplyTo: null,
      from: { email: from, name: "Lead" },
      to: [f.mailbox],
      subject: "Re: hello",
      bodyText: "Could we book a demo next week?",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
      autoReply: false,
      ...partial,
    };
  };

  const recordOf = async (personId: string) => (await sql`select id, assigned_to, assigned_source from records where person_id = ${personId}`)[0];
  const assignedEvents = (recordId: string) => sql`select actor_type, actor_user_id, from_data, to_data, meta from events where record_id = ${recordId} and event_type = 'assignee.changed' order by created_at, id`;

  beforeAll(async () => {
    composition = await import("../../../infrastructure/composition");
    assignment = await import("../../application/assignment");
    deps = (await import("../assignment-composition")).assignmentDeps();
    workQueue = await import("../../application/work-queue");
    queueDeps = (await import("../work-queue-composition")).workQueueDeps();
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs.map((organizationId) => ({ organizationId })), users);
    await sql.end();
  });

  it("assigns the creator of the campaign the lead was enrolled in, and records who did it", async () => {
    const f = await fixture();
    const lead = await enrolledLead(f);
    await enroll(f, await campaign(f, f.ann), lead.personId, "2026-10-01T09:00:00Z");

    await composition.ingestInbound(mail(f, lead.email));

    const record = await recordOf(lead.personId);
    expect(record).toMatchObject({ assigned_to: f.ann, assigned_source: "auto" });
    const events = await assignedEvents(record.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_type: "system", actor_user_id: null, from_data: { assignedTo: null }, to_data: { assignedTo: f.ann }, meta: { source: "auto" } });
  });

  it("prefers the newest enrollment and skips a creator who is not a member", async () => {
    const f = await fixture();
    const newer = await enrolledLead(f);
    await enroll(f, await campaign(f, f.ann), newer.personId, "2026-10-01T09:00:00Z");
    await enroll(f, await campaign(f, f.bob), newer.personId, "2026-10-05T09:00:00Z");
    await composition.ingestInbound(mail(f, newer.email));
    expect((await recordOf(newer.personId)).assigned_to).toBe(f.bob);

    const skipped = await enrolledLead(f);
    await enroll(f, await campaign(f, f.ann), skipped.personId, "2026-10-01T09:00:00Z");
    await enroll(f, await campaign(f, f.carl), skipped.personId, "2026-10-09T09:00:00Z");
    await composition.ingestInbound(mail(f, skipped.email));
    expect((await recordOf(skipped.personId)).assigned_to).toBe(f.ann);
  });

  it("leaves a record unassigned when nothing identifies a member", async () => {
    const f = await fixture();
    // An unknown sender has no enrollment at all.
    const stranger = await composition.ingestInbound(mail(f, `stranger-${f.tag}@nowhere.test`));
    expect((await recordOf(stranger.personId)).assigned_to).toBeNull();

    // A creator who is no member, a campaign without a creator, a removed enrollment and a personal campaign do not count.
    const lead = await enrolledLead(f);
    await enroll(f, await campaign(f, f.carl), lead.personId, "2026-10-01T09:00:00Z");
    await enroll(f, await campaign(f, null), lead.personId, "2026-10-02T09:00:00Z");
    await enroll(f, await campaign(f, f.ann), lead.personId, "2026-10-03T09:00:00Z", "removed");
    await enroll(f, await campaign(f, f.bob, { type: "personal" }), lead.personId, "2026-10-04T09:00:00Z", "active", "linkedin");
    await composition.ingestInbound(mail(f, lead.email));
    const record = await recordOf(lead.personId);
    expect(record.assigned_to).toBeNull();
    expect(await assignedEvents(record.id)).toHaveLength(0);
  });

  it("does not assign on an automatic reply", async () => {
    const f = await fixture();
    const lead = await enrolledLead(f);
    await enroll(f, await campaign(f, f.ann), lead.personId, "2026-10-01T09:00:00Z");
    await composition.ingestInbound(mail(f, lead.email, { autoReply: true }));
    expect((await recordOf(lead.personId))?.assigned_to ?? null).toBeNull();
  });

  it("never replaces an assignee, whoever set it", async () => {
    const f = await fixture();
    const lead = await enrolledLead(f);
    await enroll(f, await campaign(f, f.ann), lead.personId, "2026-10-01T09:00:00Z");
    await composition.ingestInbound(mail(f, lead.email));
    const record = await recordOf(lead.personId);
    expect(record.assigned_to).toBe(f.ann);

    // A person hands it to Bob. Another reply comes in; Bob keeps it and no second event is written.
    await sql`update records set assigned_to = ${f.bob}, assigned_source = 'human' where id = ${record.id}`;
    await composition.ingestInbound(mail(f, lead.email, { receivedAt: new Date("2026-10-15T10:00:00Z") }));
    expect(await recordOf(lead.personId)).toMatchObject({ assigned_to: f.bob, assigned_source: "human" });
    expect(await assignedEvents(record.id)).toHaveLength(1);
  });

  it("leaves a conversation unassigned that a person set to Nobody, until a person takes it", async () => {
    const f = await fixture();
    const lead = await enrolledLead(f);
    await enroll(f, await campaign(f, f.ann), lead.personId, "2026-10-01T09:00:00Z");
    await composition.ingestInbound(mail(f, lead.email));
    const record = await recordOf(lead.personId);
    expect(record).toMatchObject({ assigned_to: f.ann, assigned_source: "auto" });

    const ann: Actor = { userId: f.ann, organizationId: f.org, role: "owner" };
    await assignment.assignRecord(deps, ann, record.id, { assignedTo: null, expectedAssignedTo: f.ann });
    expect(await recordOf(lead.personId)).toMatchObject({ assigned_to: null, assigned_source: "cleared" });

    // The lead writes again. Nobody was a choice, so the campaign creator does not get it back and no event is written.
    await composition.ingestInbound(mail(f, lead.email, { receivedAt: new Date("2026-10-15T10:00:00Z") }));
    expect(await recordOf(lead.personId)).toMatchObject({ assigned_to: null, assigned_source: "cleared" });
    expect(await assignedEvents(record.id)).toHaveLength(2);

    // A person who takes it afterwards is a human choice again.
    await assignment.claimRecord(deps, ann, record.id);
    expect(await recordOf(lead.personId)).toMatchObject({ assigned_to: f.ann, assigned_source: "human" });
  });

  it("assigns again after the assignee leaves the organization, to a creator who is still a member", async () => {
    const f = await fixture();
    const lead = await enrolledLead(f);
    await enroll(f, await campaign(f, f.ann), lead.personId, "2026-10-01T09:00:00Z");
    await enroll(f, await campaign(f, f.bob), lead.personId, "2026-10-05T09:00:00Z");
    await composition.ingestInbound(mail(f, lead.email));
    const record = await recordOf(lead.personId);
    expect(record.assigned_to).toBe(f.bob);

    await sql`delete from members where organization_id = ${f.org} and user_id = ${f.bob}`;
    expect((await recordOf(lead.personId)).assigned_to).toBeNull();

    await composition.ingestInbound(mail(f, lead.email, { receivedAt: new Date("2026-10-16T10:00:00Z") }));
    expect((await recordOf(lead.personId)).assigned_to).toBe(f.ann);
    expect(await assignedEvents(record.id)).toHaveLength(2);
  });

  it("assigns on a LinkedIn reply the same way", async () => {
    const f = await fixture();
    const [{ id: account }] = await sql`
      insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, name, status)
      values (${f.org}, ${f.account}, ${"ACo-" + f.tag}, 'Jo Owner', 'connected') returning id`;
    const slug = `ada-${f.tag}`;
    const [{ id: personId }] = await sql`insert into people (organization_id, full_name, linkedin_slug) values (${f.org}, 'Ada', ${slug}) returning id`;
    await enroll(f, await campaign(f, f.ann, { channel: "linkedin" }), personId, "2026-10-01T09:00:00Z", "active", "linkedin");

    const n = ++counter;
    const input: InboundLinkedInInput = {
      organizationId: f.org,
      accountRef: account as string,
      accountName: "Jo Owner",
      providerThreadId: `chat-${n}`,
      providerMessageId: `msg-${n}`,
      counterparty: { providerId: `ACo-lead-${n}`, name: "Ada", profileUrl: `https://www.linkedin.com/in/${slug}`, slug },
      personId: null,
      bodyText: "Sounds good",
      receivedAt: new Date("2026-10-14T10:00:00Z"),
    };
    await composition.ingestInboundLinkedInMessage(input);
    expect(await recordOf(personId)).toMatchObject({ assigned_to: f.ann, assigned_source: "auto" });
  });
  describe("claim and assign", () => {
    const actorOf = (f: Fx, userId: string): Actor => ({ userId, organizationId: f.org, role: "member" });

    /** An unassigned record with a draft waiting for review, from a sender no campaign knows. */
    async function unassigned(f: Fx) {
      const stranger = await composition.ingestInbound(mail(f, `stranger${++counter}-${f.tag}@nowhere.test`));
      const record = await recordOf(stranger.personId);
      expect(record.assigned_to).toBeNull();
      const [r] = await sql`select context_version, updated_at from records where id = ${record.id}`;
      const [draft] = await sql`
        insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, subject, ai_body_text, status)
        values (${f.org}, ${record.id}, ${stranger.conversationId}, ${r.context_version}, 'email', 'Re: hello', 'Sure.', 'awaiting_review') returning id`;
      return { recordId: record.id as string, personId: stranger.personId, conversationId: stranger.conversationId, draftId: draft.id as string, contextVersion: r.context_version as number, updatedAt: r.updated_at as Date };
    }

    it("claims an unassigned conversation, writes the event, and leaves the context version, the draft and updated_at alone", async () => {
      const f = await fixture();
      const r = await unassigned(f);

      const result = await assignment.claimRecord(deps, actorOf(f, f.ann), r.recordId);

      expect(result).toEqual({ recordId: r.recordId, assignedTo: f.ann, previousAssignedTo: null, changed: true });
      const [row] = await sql`select assigned_to, assigned_source, context_version, updated_at from records where id = ${r.recordId}`;
      expect(row).toMatchObject({ assigned_to: f.ann, assigned_source: "human", context_version: r.contextVersion });
      expect(row.updated_at).toEqual(r.updatedAt);
      expect((await sql`select status from drafts where id = ${r.draftId}`)[0].status).toBe("awaiting_review");
      const events = await assignedEvents(r.recordId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor_type: "human", actor_user_id: f.ann, from_data: { assignedTo: null, assigneeName: null }, to_data: { assignedTo: f.ann, assigneeName: "Ann" }, meta: { source: "human", action: "claim" } });
    });

    it("changes nothing when you claim what you already hold, and refuses what someone else holds", async () => {
      const f = await fixture();
      const r = await unassigned(f);
      await assignment.claimRecord(deps, actorOf(f, f.ann), r.recordId);

      expect(await assignment.claimRecord(deps, actorOf(f, f.ann), r.recordId)).toMatchObject({ assignedTo: f.ann, changed: false });
      await expect(assignment.claimRecord(deps, actorOf(f, f.bob), r.recordId)).rejects.toBeInstanceOf(ConflictError);
      expect((await recordOf(r.personId)).assigned_to).toBe(f.ann);
      expect(await assignedEvents(r.recordId)).toHaveLength(1);
    });

    it("lets two people claim at once and gives it to one of them", async () => {
      const f = await fixture();
      const r = await unassigned(f);
      // A third transaction holds the row, so both claims are in flight before either can write. Without the row lock in the
      // store, both would read "unassigned" and both would win.
      let release!: () => void;
      let locked!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const holder = sql.begin(async (tx) => {
        await tx`select id from records where id = ${r.recordId} for update`;
        locked();
        await gate;
      });
      await holding;
      const attempts = Promise.allSettled([assignment.claimRecord(deps, actorOf(f, f.ann), r.recordId), assignment.claimRecord(deps, actorOf(f, f.bob), r.recordId)]);
      await waitForLockWaiters(sql, 2);
      release();
      await holder;
      const settled = await attempts;

      const won = settled.filter((a) => a.status === "fulfilled");
      const lost = settled.filter((a): a is PromiseRejectedResult => a.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0].reason).toBeInstanceOf(ConflictError);
      expect(await assignedEvents(r.recordId)).toHaveLength(1);
    });

    it("assigns to a member who was seen holding it, to nobody, and back", async () => {
      const f = await fixture();
      const r = await unassigned(f);
      const ann = actorOf(f, f.ann);

      expect(await assignment.assignRecord(deps, ann, r.recordId, { assignedTo: f.bob, expectedAssignedTo: null })).toMatchObject({ assignedTo: f.bob, previousAssignedTo: null, changed: true });
      expect(await assignment.assignRecord(deps, ann, r.recordId, { assignedTo: f.ann, expectedAssignedTo: f.bob })).toMatchObject({ assignedTo: f.ann, previousAssignedTo: f.bob });
      expect(await assignment.assignRecord(deps, ann, r.recordId, { assignedTo: null, expectedAssignedTo: f.ann })).toMatchObject({ assignedTo: null, previousAssignedTo: f.ann });
      expect(await assignment.assignRecord(deps, ann, r.recordId, { assignedTo: null, expectedAssignedTo: null })).toMatchObject({ changed: false });

      expect(await recordOf(r.personId)).toMatchObject({ assigned_to: null, assigned_source: "cleared" });
      const events = await assignedEvents(r.recordId);
      expect(events.map((e) => [e.from_data.assigneeName, e.to_data.assigneeName])).toEqual([[null, "Bob"], ["Bob", "Ann"], ["Ann", null]]);
    });

    it("refuses a change made from a stale view, and a target who is not a member", async () => {
      const f = await fixture();
      const r = await unassigned(f);
      await assignment.claimRecord(deps, actorOf(f, f.ann), r.recordId);

      // Bob looked while it was unassigned.
      await expect(assignment.assignRecord(deps, actorOf(f, f.bob), r.recordId, { assignedTo: f.bob, expectedAssignedTo: null })).rejects.toBeInstanceOf(ConflictError);
      // Carl is no member of this organization, and a made-up user is nobody.
      await expect(assignment.assignRecord(deps, actorOf(f, f.ann), r.recordId, { assignedTo: f.carl, expectedAssignedTo: f.ann })).rejects.toBeInstanceOf(ValidationError);
      await expect(assignment.assignRecord(deps, actorOf(f, f.ann), r.recordId, { assignedTo: "00000000-0000-4000-8000-000000000000", expectedAssignedTo: f.ann })).rejects.toBeInstanceOf(ValidationError);
      expect((await recordOf(r.personId)).assigned_to).toBe(f.ann);
      expect(await assignedEvents(r.recordId)).toHaveLength(1);
    });

    it("answers 404 for another organization's record, an id that is no UUID, and a record that exists only for a private thread", async () => {
      const f = await fixture();
      const other = await fixture();
      const mine = await unassigned(f);
      const theirs = await unassigned(other);

      await expect(assignment.claimRecord(deps, actorOf(f, f.ann), theirs.recordId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(assignment.assignRecord(deps, actorOf(f, f.ann), theirs.recordId, { assignedTo: f.ann, expectedAssignedTo: null })).rejects.toBeInstanceOf(NotFoundError);
      await expect(assignment.claimRecord(deps, actorOf(f, f.ann), "not-an-id")).rejects.toBeInstanceOf(NotFoundError);
      expect((await recordOf(theirs.personId)).assigned_to).toBeNull();

      const [{ id: campaignId }] = await sql`insert into campaigns (organization_id, name, channel, type) values (${f.org}, 'Personal', 'linkedin', 'personal') returning id`;
      await sql`update conversations set private_campaign_id = ${campaignId} where id = ${mine.conversationId}`;
      await expect(assignment.claimRecord(deps, actorOf(f, f.ann), mine.recordId)).rejects.toBeInstanceOf(NotFoundError);
      expect((await recordOf(mine.personId)).assigned_to).toBeNull();
    });
  });
  describe("scopes of the work queue", () => {
    const actorOf = (f: Fx, userId: string): Actor => ({ userId, organizationId: f.org, role: "member" });

    async function waiting(f: Fx, assignedTo: string | null) {
      const stranger = await composition.ingestInbound(mail(f, `scope${++counter}-${f.tag}@nowhere.test`));
      const record = await recordOf(stranger.personId);
      if (assignedTo) await sql`update records set assigned_to = ${assignedTo}, assigned_source = 'human' where id = ${record.id}`;
      return { recordId: record.id as string, personId: stranger.personId };
    }
    const task = (f: Fx, personId: string, recordId: string | null, assignedTo: string | null) =>
      sql`insert into tasks (organization_id, person_id, record_id, name, assigned_to) values (${f.org}, ${personId}, ${recordId}, ${"Call " + ++counter}, ${assignedTo})`;
    const ids = (page: { items: Array<{ recordId: string }> }) => page.items.map((i) => i.recordId).sort();

    it("splits the queue by assignee into scopes that add up to the whole", async () => {
      const f = await fixture();
      const mine = await waiting(f, f.ann);
      const alsoMine = await waiting(f, f.ann);
      const theirs = await waiting(f, f.bob);
      const nobody = await waiting(f, null);
      const ann = actorOf(f, f.ann);
      const queue = (scope?: string) => workQueue.getWorkQueue(queueDeps, ann, { filter: scope ? { scope } : {} });

      expect(ids((await queue("mine")).groups.next_step)).toEqual([mine.recordId, alsoMine.recordId].sort());
      expect(ids((await queue("others")).groups.next_step)).toEqual([theirs.recordId]);
      expect(ids((await queue("unassigned")).groups.next_step)).toEqual([nobody.recordId]);
      expect((await queue()).total).toBe(4);

      const counts = await workQueue.getWorkQueueCounts(queueDeps, ann);
      expect(counts.byScope).toEqual({ mine: 2, unassigned: 1, others: 1 });
      expect(counts.byScope.mine + counts.byScope.unassigned + counts.byScope.others).toBe(counts.total);
      // The totals the page shows under a scope are the counts the sidebar reads.
      for (const scope of ["mine", "unassigned", "others"] as const) expect((await queue(scope)).total).toBe(counts.byScope[scope]);

      // The same queue seen by Bob: his is theirs.
      const bobs = await workQueue.getWorkQueueCounts(queueDeps, actorOf(f, f.bob));
      expect(bobs.byScope).toEqual({ mine: 1, unassigned: 1, others: 2 });
    });

    it("reports the oldest wait inside each scope, so the headline of a view never quotes someone else's item", async () => {
      const f = await fixture();
      const at = (recordId: string, iso: string) => sql`update records set last_inbound_at = ${iso}, last_interaction_at = ${iso} where id = ${recordId}`;
      const mineNew = await waiting(f, f.ann);
      const mineOld = await waiting(f, f.ann);
      const theirs = await waiting(f, f.bob);
      const nobody = await waiting(f, null);
      await at(mineNew.recordId, "2026-10-12T09:00:00Z");
      await at(mineOld.recordId, "2026-10-09T09:00:00Z");
      await at(theirs.recordId, "2026-10-01T09:00:00Z");
      await at(nobody.recordId, "2026-10-05T09:00:00Z");

      const counts = await workQueue.getWorkQueueCounts(queueDeps, actorOf(f, f.ann));
      expect(counts.oldestWaiting).toEqual({ mine: new Date("2026-10-09T09:00:00Z"), unassigned: new Date("2026-10-05T09:00:00Z"), others: new Date("2026-10-01T09:00:00Z") });

      // Seen by Bob the scopes turn around, and a scope with nothing waiting reports null.
      const bobs = await workQueue.getWorkQueueCounts(queueDeps, actorOf(f, f.bob));
      expect(bobs.oldestWaiting).toEqual({ mine: new Date("2026-10-01T09:00:00Z"), unassigned: new Date("2026-10-05T09:00:00Z"), others: new Date("2026-10-09T09:00:00Z") });
      const empty = await fixture();
      expect((await workQueue.getWorkQueueCounts(queueDeps, actorOf(empty, empty.ann))).oldestWaiting).toEqual({ mine: null, unassigned: null, others: null });
    });

    it("puts the assignee on each item", async () => {
      const f = await fixture();
      const mine = await waiting(f, f.ann);
      const nobody = await waiting(f, null);
      const items = (await workQueue.getWorkQueue(queueDeps, actorOf(f, f.bob))).groups.next_step.items;
      expect(items.find((i) => i.recordId === mine.recordId)?.assignee).toEqual({ id: f.ann, name: "Ann" });
      expect(items.find((i) => i.recordId === nobody.recordId)?.assignee).toBeNull();
    });

    it("counts open tasks by assignee and never counts a record and its task twice", async () => {
      const f = await fixture();
      const ann = actorOf(f, f.ann);
      const handled = await waiting(f, f.ann);
      // Ann holds the record and also has a task on it: the record leaves the queue and Ann's work stays one item.
      await task(f, handled.personId, handled.recordId, f.ann);
      const other = await waiting(f, f.bob);
      await task(f, other.personId, null, f.ann);
      await task(f, other.personId, null, null);
      await task(f, other.personId, null, f.bob);
      await sql`insert into tasks (organization_id, person_id, name, assigned_to, is_completed, completed_at) values (${f.org}, ${other.personId}, 'Done', ${f.ann}, true, now())`;

      const counts = await workQueue.getWorkQueueCounts(queueDeps, ann);
      expect(counts.byScope).toEqual({ mine: 0, unassigned: 0, others: 1 });
      expect(counts.tasks).toEqual({ mine: 2, unassigned: 1, others: 1 });
      expect(counts.work).toEqual({ mine: 2, unassigned: 1, others: 2 });
    });

    it("leaves out the tasks of a record that exists only for a private thread, and another organization's work", async () => {
      const f = await fixture();
      const stranger = await waiting(f, f.ann);
      await task(f, stranger.personId, stranger.recordId, f.ann);
      const [{ id: campaignId }] = await sql`insert into campaigns (organization_id, name, channel, type) values (${f.org}, 'Personal', 'linkedin', 'personal') returning id`;
      await sql`update conversations set private_campaign_id = ${campaignId} where record_id = ${stranger.recordId}`;
      const other = await fixture();
      await waiting(other, null);

      const counts = await workQueue.getWorkQueueCounts(queueDeps, actorOf(f, f.ann));
      expect(counts.work).toEqual({ mine: 0, unassigned: 0, others: 0 });
      expect(counts.total).toBe(0);
    });

    it("refuses a scope it does not know", async () => {
      const f = await fixture();
      await expect(workQueue.getWorkQueue(queueDeps, actorOf(f, f.ann), { filter: { scope: "everyone" } })).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
