import { afterAll, beforeAll, expect, it } from "vitest";
import type { InboundReviewDeps } from "../../application/inbound-review";
import type { InboundStore } from "../../application/inbound-ports";
import type { InboxDeps } from "../../email/application/sync-inbox";
import { ConflictError, ForbiddenError, NotFoundError, type Actor } from "@/shared/errors";
import { FakeMailboxProvider } from "../../email/infrastructure/fake-mailbox-provider";
import { createTestOrg, describeDb, dropOrgs, type TestOrg, testSql, uniqueKey, useTestEnv } from "@/test-support/db";

/** Needs TEST_DATABASE_URL pointing at a migrated Postgres. */

describeDb("inbound event review", () => {
  useTestEnv();
  const sql = testSql({ max: 6 });
  let review: typeof import("../../application/inbound-review");
  let sync: typeof import("../../email/application/sync-inbox");
  let inboundStore: InboundStore;
  let linkedinStore: ReturnType<typeof import("../../linkedin/infrastructure/drizzle-linkedin-inbound-store").createDrizzleLinkedInInboundStore>;
  const orgs: Array<Pick<TestOrg, "organizationId"> & Partial<Pick<TestOrg, "userId">>> = [];

  let current = new Date("2026-10-14T10:00:00Z");
  const clock = { now: () => current };
  const advance = (minutes: number) => {
    current = new Date(current.getTime() + minutes * 60_000);
  };
  let deps: InboundReviewDeps;
  const inbox = (provider: FakeMailboxProvider, store: InboundStore = inboundStore): InboxDeps => ({ store, provider, clock, minIntervalSeconds: 0 });

  async function fixture() {
    const tag = uniqueKey();
    const created = await createTestOrg(sql, "R", "admin");
    orgs.push(created);
    const { organizationId: org, userId } = created;
    await sql`update users set name = 'Ada Admin' where id = ${userId}`;
    const [{ id: other }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values ('R2', ${"rev2-" + tag}) returning id`;
    orgs.push({ organizationId: other });
    const address = `box-${tag}@corp.test`;
    const [{ id: mailbox }] = await sql`
      insert into mailboxes (organization_id, email_address, display_name, status) values (${org}, ${address}, 'Box', 'connected') returning id`;
    const admin: Actor = { userId, organizationId: org, role: "admin" };
    const member: Actor = { userId, organizationId: org, role: "member" };
    const outsider: Actor = { userId, organizationId: other, role: "owner" };
    return { org, other, mailbox, address, admin, member, outsider, tag };
  }

  const events = (org: string) => sql`select * from inbound_events where organization_id = ${org} order by created_at`;
  const mailboxRow = async (id: string) => (await sql`select * from mailboxes where id = ${id}`)[0];
  const storedMessages = (org: string) => sql`select * from messages where organization_id = ${org}`;

  /** A stranger writes in, the ingest throws on it five times, and the sync gives up on it. */
  async function deadLetter() {
    const f = await fixture();
    const provider = new FakeMailboxProvider();
    await sync.syncMailboxInbox(inbox(provider), f.mailbox);
    const poison = provider.deliverInbound(f.address, { from: { email: `stranger-${f.tag}@acme.test`, name: "Stranger" }, subject: "poison", bodyText: "secret body text" });
    let failing = true;
    const flaky: InboundStore = {
      ...inboundStore,
      async applyInbound(mailbox, email, classification, now) {
        if (failing && email.subject === "poison") throw new Error("constraint violation");
        return inboundStore.applyInbound(mailbox, email, classification, now);
      },
    };
    for (let i = 0; i < 5; i++) await sync.syncMailboxInbox(inbox(provider, flaky), f.mailbox);
    const [event] = await events(f.org);
    expect(event).toMatchObject({ status: "failed", attempts: 5 });
    return { ...f, provider, poison, flaky, event, heal: () => (failing = false) };
  }

  async function linkedinEvent(org: string, over: { status: string; attempts: number; key?: string; error?: string }) {
    const [{ id }] = await sql`
      insert into inbound_events (organization_id, provider, provider_event_key, event_type, account_ref, payload, status, attempts, log)
      values (${org}, 'unipile', ${over.key ?? `unipile:message_received:v1:${Math.random()}`}, 'message_received', 'acc-1', ${sql.json({ text: "private text" })}, ${over.status}, ${over.attempts},
        ${sql.json([{ ts: current.toISOString(), level: "error", message: over.error ?? "boom" }])})
      returning id`;
    return id as string;
  }

  beforeAll(async () => {
    review = await import("../../application/inbound-review");
    sync = await import("../../email/application/sync-inbox");
    inboundStore = (await import("../../email/infrastructure/drizzle-inbound-store")).createDrizzleInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
    linkedinStore = (await import("../../linkedin/infrastructure/drizzle-linkedin-inbound-store")).createDrizzleLinkedInInboundStore((await import("@/composition/inbox-filing")).inboxFiling);
    const { drizzleInboundReviewStore } = await import("../drizzle-inbound-review-store");
    deps = { store: drizzleInboundReviewStore, now: clock.now };
  });

  afterAll(async () => {
    await dropOrgs(sql, orgs);
    await sql.end();
  });

  it("lists dead letters with source, account, attempts and a short error, and no body text", async () => {
    const f = await deadLetter();
    const longError = "x".repeat(900);
    const linkedin = await linkedinEvent(f.org, { status: "failed", attempts: 8, error: longError });
    await linkedinEvent(f.org, { status: "failed", attempts: 2 });
    await linkedinEvent(f.org, { status: "done", attempts: 1 });

    const open = await review.listInboundEvents(deps, f.admin);
    expect(open.total).toBe(2);
    const gmail = open.rows.find((r) => r.source === "gmail");
    expect(gmail).toMatchObject({ accountRef: f.address, state: "dead", attempts: 5, from: `stranger-${f.tag}@acme.test`, subject: "poison" });
    expect(gmail?.error).toContain("constraint violation");
    const li = open.rows.find((r) => r.id === linkedin);
    expect(li).toMatchObject({ source: "linkedin", state: "dead", attempts: 8, accountRef: "acc-1" });
    expect(li?.error).toHaveLength(300);
    expect(JSON.stringify(open.rows)).not.toContain("secret body text");
    expect(JSON.stringify(open.rows)).not.toContain("private text");

    expect((await review.listInboundEvents(deps, f.admin, { source: "gmail" })).total).toBe(1);
    expect((await review.listInboundEvents(deps, f.admin, { source: "linkedin" })).total).toBe(1);
    expect((await review.listInboundEvents(deps, f.admin, { state: "retrying" })).rows).toMatchObject([{ source: "linkedin", attempts: 2, state: "retrying" }]);
    expect((await review.listInboundEvents(deps, f.admin, { state: "all" })).total).toBe(3);

    const page1 = await review.listInboundEvents(deps, f.admin, { state: "all", limit: 2 });
    const page2 = await review.listInboundEvents(deps, f.admin, { state: "all", limit: 2, offset: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
    expect(new Set([...page1.rows, ...page2.rows].map((r) => r.id)).size).toBe(3);
  });

  it("only an owner or admin may list, retry or dismiss", async () => {
    const f = await deadLetter();
    await expect(review.listInboundEvents(deps, f.member)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(review.retryInboundEvent(deps, f.member, f.event.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(review.dismissInboundEvent(deps, f.member, f.event.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await events(f.org))[0].status).toBe("failed");
    expect((await review.listInboundEvents(deps, { ...f.admin, role: "owner" })).total).toBe(1);
  });

  it("answers 404 for another organization's event and for a malformed id", async () => {
    const f = await deadLetter();
    await expect(review.retryInboundEvent(deps, f.outsider, f.event.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(review.dismissInboundEvent(deps, f.outsider, f.event.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(review.retryInboundEvent(deps, f.admin, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    expect((await review.listInboundEvents(deps, f.outsider)).total).toBe(0);
    expect((await events(f.org))[0].status).toBe("failed");
  });

  it("retry fetches the skipped message again and the sync applies it", async () => {
    const f = await deadLetter();
    expect(await storedMessages(f.org)).toHaveLength(0);
    expect((await mailboxRow(f.mailbox)).last_error).toContain("/settings/inbound-events");
    f.heal();

    // The cursor is past the message: another sync alone does not bring it back.
    await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(await storedMessages(f.org)).toHaveLength(0);

    expect(await review.retryInboundEvent(deps, f.admin, f.event.id)).toEqual({ state: "queued" });
    expect(await events(f.org)).toMatchObject([{ status: "pending", attempts: 0 }]);
    // The dead-letter sentence goes away as soon as nothing is dead any more.
    expect((await mailboxRow(f.mailbox)).last_error).toBeNull();
    expect((await review.listInboundEvents(deps, f.admin, { state: "queued" })).total).toBe(1);

    const outcome = await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(outcome).toMatchObject({ kind: "synced", counts: { unmatched_message: 1 } });
    expect(await storedMessages(f.org)).toMatchObject([{ body_text: "secret body text" }]);
    expect(await events(f.org)).toMatchObject([{ status: "done" }]);
    expect((await review.listInboundEvents(deps, f.admin, { state: "all" })).total).toBe(0);
    await expect(review.retryInboundEvent(deps, f.admin, f.event.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(review.dismissInboundEvent(deps, f.admin, f.event.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("a retry that fails again goes through the five attempts and dead-letters once more", async () => {
    const f = await deadLetter();
    await review.retryInboundEvent(deps, f.admin, f.event.id);
    for (let i = 1; i <= 4; i++) {
      expect(await sync.syncMailboxInbox(inbox(f.provider, f.flaky), f.mailbox)).toMatchObject({ kind: "failed", error: expect.stringContaining(`attempt ${i} of 5`) });
    }
    expect(await sync.syncMailboxInbox(inbox(f.provider, f.flaky), f.mailbox)).toMatchObject({ kind: "synced", counts: { dead_lettered: 1 } });
    expect(await events(f.org)).toMatchObject([{ status: "failed", attempts: 5 }]);
    expect((await mailboxRow(f.mailbox)).last_error).toContain("1 inbound message failed 5 times");
  });

  it("retry is idempotent, and a message gone from the mailbox dead-letters with a reason", async () => {
    const f = await deadLetter();
    await review.retryInboundEvent(deps, f.admin, f.event.id);
    expect(await review.retryInboundEvent(deps, f.admin, f.event.id)).toEqual({ state: "queued" });
    expect(await events(f.org)).toMatchObject([{ status: "pending", attempts: 0 }]);

    // A provider that no longer holds the message.
    await sync.syncMailboxInbox(inbox(new FakeMailboxProvider()), f.mailbox);
    const [row] = await events(f.org);
    expect(row.status).toBe("failed");
    const list = await review.listInboundEvents(deps, f.admin);
    expect(list.rows[0].error).toContain("no longer in the mailbox");
  });

  it("dismiss records who and when, is idempotent and keeps the message from coming back", async () => {
    const f = await deadLetter();
    advance(10);
    expect(await review.dismissInboundEvent(deps, f.admin, f.event.id)).toEqual({ state: "dismissed" });
    advance(10);
    expect(await review.dismissInboundEvent(deps, f.admin, f.event.id)).toEqual({ state: "dismissed" });

    expect((await review.listInboundEvents(deps, f.admin)).total).toBe(0);
    const dismissed = await review.listInboundEvents(deps, f.admin, { state: "dismissed" });
    expect(dismissed.rows).toMatchObject([{ state: "dismissed", dismissedBy: "Ada Admin", dismissedAt: new Date("2026-10-14T10:10:00Z") }]);
    const log = (await events(f.org))[0].log as Array<{ level: string }>;
    expect(log.filter((l) => l.level === "dismissed")).toHaveLength(1);
    expect((await mailboxRow(f.mailbox)).last_error).toBeNull();

    // A replayed history batch skips the dismissed message.
    f.heal();
    await sql`update mailboxes set gmail_history_cursor = '0' where id = ${f.mailbox}`;
    await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(await storedMessages(f.org)).toHaveLength(0);
    expect(await events(f.org)).toMatchObject([{ status: "skipped" }]);

    // Dismissed events can be brought back.
    await review.retryInboundEvent(deps, f.admin, f.event.id);
    await sync.syncMailboxInbox(inbox(f.provider), f.mailbox);
    expect(await storedMessages(f.org)).toHaveLength(1);
  });

  it("the mailbox note keeps other errors and counts the dead letters that remain", async () => {
    const f = await fixture();
    const provider = new FakeMailboxProvider();
    await sync.syncMailboxInbox(inbox(provider), f.mailbox);
    provider.deliverInbound(f.address, { subject: "poison", from: { email: `a-${f.tag}@acme.test`, name: null } });
    provider.deliverInbound(f.address, { subject: "poison", from: { email: `b-${f.tag}@acme.test`, name: null } });
    const flaky: InboundStore = {
      ...inboundStore,
      async applyInbound() {
        throw new Error("down");
      },
    };
    // The batch stops at the first failing message, so the second one starts failing once the first is dead.
    for (let i = 0; i < 10; i++) await sync.syncMailboxInbox(inbox(provider, flaky), f.mailbox);
    const [first] = await events(f.org);
    expect(await events(f.org)).toHaveLength(2);
    expect((await mailboxRow(f.mailbox)).last_error).toContain("2 inbound messages failed 5 times");
    await sql`update mailboxes set last_error = 'Inbox cursor expired. ' || last_error where id = ${f.mailbox}`;

    await review.dismissInboundEvent(deps, f.admin, first.id);
    const note = (await mailboxRow(f.mailbox)).last_error as string;
    expect(note).toContain("Inbox cursor expired.");
    expect(note).toContain("1 inbound message failed 5 times");
    expect(note).not.toContain("2 inbound");
  });

  it("LinkedIn retry marks the delivery for the replay job, which claims it", async () => {
    const f = await fixture();
    const id = await linkedinEvent(f.org, { status: "failed", attempts: 8 });
    expect((await linkedinStore.claimReplayable(current, 50, 300)).map((c) => c.id)).not.toContain(id);
    await review.retryInboundEvent(deps, f.admin, id);
    expect(await review.retryInboundEvent(deps, f.admin, id)).toEqual({ state: "queued" });
    const claimed = await linkedinStore.claimReplayable(new Date(current.getTime() + 1000), 50, 300);
    expect(claimed.map((c) => c.id)).toContain(id);
  });

  it("a LinkedIn delivery that is still retrying by itself can be dismissed but not retried", async () => {
    const f = await fixture();
    const id = await linkedinEvent(f.org, { status: "failed", attempts: 3 });
    await expect(review.retryInboundEvent(deps, f.admin, id)).rejects.toBeInstanceOf(ConflictError);
    await review.dismissInboundEvent(deps, f.admin, id);
    expect((await review.listInboundEvents(deps, f.admin, { state: "dismissed" })).rows).toMatchObject([{ id, source: "linkedin" }]);
    const claimed = await linkedinStore.claimReplayable(new Date(current.getTime() + 3_600_000), 50, 300);
    expect(claimed.map((c) => c.id)).not.toContain(id);
  });
});
