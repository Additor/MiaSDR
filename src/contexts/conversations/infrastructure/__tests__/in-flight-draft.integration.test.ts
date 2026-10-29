import { beforeAll, expect, it } from "vitest";
import { ConflictError } from "@/shared/errors";
import { describeDb, waitForLockWaiters } from "@/test-support/db";
import type { ReplyMailer } from "../../application/reply-ports";
import { useReplyKit, type ReplyFixture, type ReplyModules } from "./replies-test-kit";

const SENDING = "A reply is already being sent in this thread.";
/** The index's refusal. The check gives SENDING or UNCERTAIN, so a test that expects those proves the check ran. */
const STARTED_FIRST = "Another reply in this thread started sending first. Reload the thread.";
const UNCERTAIN = "An earlier reply in this thread has an unconfirmed outcome. Check the mailbox and mark what you found first.";

describeDb("one in-flight email reply per conversation", () => {
  const { sql, modules, fixture, mail, one, count, receive, panel, sendKey } = useReplyKit();
  let composition: ReplyModules["composition"];
  let mgmt: ReplyModules["mgmt"];
  let mailbox: ReplyModules["mailbox"];

  beforeAll(() => {
    ({ composition, mgmt, mailbox } = modules);
  });

  /** Counts provider calls on the fixture's mailer. Each call waits for `release` when `gated`. */
  function watchMailer(f: ReplyFixture, gated = false) {
    const inner: ReplyMailer = f.replyDeps.mailer;
    let release!: () => void;
    const gate = gated ? new Promise<void>((r) => (release = r)) : Promise.resolve();
    const seen = { calls: 0, release: () => release?.() };
    f.replyDeps.mailer = {
      send: async (request) => {
        seen.calls += 1;
        await gate;
        return inner.send(request);
      },
      findSent: (...args) => inner.findSent(...args),
    };
    return seen;
  }

  async function withDraft(f: ReplyFixture) {
    const r = await receive(f);
    const p = await panel(f, r.conversationId);
    return { r, draft: p.draft! };
  }

  /** A second open draft on the same conversation and context version. The product writes only one; the races need two. */
  async function twin(draftId: string): Promise<string> {
    const [row] = await sql`
      insert into drafts (organization_id, record_id, conversation_id, reply_for_message_id, expected_context_version, channel, subject, ai_body_text, status, provider)
      select organization_id, record_id, conversation_id, reply_for_message_id, expected_context_version, channel, subject, ai_body_text, 'awaiting_review', provider
      from drafts where id = ${draftId} returning id`;
    return row.id as string;
  }

  it("refuses a newer AI draft while an earlier reply of the thread has an unconfirmed outcome, and calls no mailer", async () => {
    const f = await fixture();
    const { r, draft: first } = await withDraft(f);
    mailbox.behavior = () => "timeout-after-accept";
    expect(await mgmt.approveAndSendDraft(f.replyDeps, f.actor, first.id, { revision: first.revision, idempotencyKey: sendKey() })).toMatchObject({ status: "delivery_uncertain" });
    mailbox.behavior = () => "ok";

    // A newer reply raises the context version, and the AI writes a draft for it while the first one is unresolved.
    await composition.ingestInbound(mail(f, { providerThreadId: r.input.providerThreadId, bodyText: "Did you get my note? Could we book a demo next week?" }));
    await f.run();
    const second = await one("select id, revision from drafts where organization_id = $1 and status = 'awaiting_review'", [f.org]);
    expect(second.id).not.toBe(first.id);

    const seen = watchMailer(f);
    const refused = mgmt.approveAndSendDraft(f.replyDeps, f.actor, second.id, { revision: second.revision, idempotencyKey: sendKey() });
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow(UNCERTAIN);
    expect(seen.calls).toBe(0);
    expect(await count("send_attempts", f.org)).toBe(1);
    expect(await one("select status from drafts where id = $1", [second.id])).toMatchObject({ status: "awaiting_review" });
  });

  it("lets one of two drafts approved at once go out and refuses the other at the conversation lock", async () => {
    const f = await fixture();
    const { r, draft } = await withDraft(f);
    const other = await twin(draft.id);
    const seen = watchMailer(f, true);

    // postgres.js awaits an array a transaction returns, so the promises leave it inside an object.
    const { approvals } = await sql.begin(async (tx) => {
      // Hold the conversation so both approvals queue on its lock before either reads the drafts.
      await tx`select id from conversations where id = ${r.conversationId} for update`;
      const started = [draft.id, other].map((id) => mgmt.approveAndSendDraft(f.replyDeps, f.actor, id, { revision: 1, idempotencyKey: sendKey() }));
      started.forEach((p) => p.catch(() => undefined));
      await waitForLockWaiters(sql, 2, 10_000, "%conversations%for update%");
      return { approvals: started };
    });

    // The winner waits in the mailer with its draft `sending`; the loser's check sees it after the lock and refuses, before
    // its own update could meet the index.
    const loser = await Promise.race(approvals.map((p) => p.then(() => null, (e: unknown) => e)));
    expect(loser).toBeInstanceOf(ConflictError);
    expect((loser as Error).message).toBe(SENDING);
    seen.release();
    const settled = await Promise.allSettled(approvals);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(settled.find((s) => s.status === "fulfilled")).toMatchObject({ value: { status: "sent" } });
    expect(seen.calls).toBe(1);
    expect(await count("send_attempts", f.org)).toBe(1);
    expect(await count("drafts", f.org, "status = 'sent'")).toBe(1);
  });

  it("runs an inbound email and an approval of the thread's draft at once without a deadlock", async () => {
    const f = await fixture();
    const { r, draft } = await withDraft(f);
    const seen = watchMailer(f);

    const { ingest, approval } = await sql.begin(async (tx) => {
      // Ingest takes the conversation's key share with its message insert and then waits here, on the record. Once it goes
      // on it retires the draft, so an approval that held the draft while it waited for the conversation would deadlock.
      await tx`select id from records where id = (select record_id from drafts where id = ${draft.id}) for update`;
      const ingest = composition.ingestInbound(mail(f, { providerThreadId: r.input.providerThreadId, bodyText: "One more question." }));
      ingest.catch(() => undefined);
      await waitForLockWaiters(sql, 1, 10_000, "%update%records%");
      // The approval waits on the conversation behind the ingest, holding nothing.
      const approval = mgmt.approveAndSendDraft(f.replyDeps, f.actor, draft.id, { revision: draft.revision, idempotencyKey: sendKey() });
      approval.catch(() => undefined);
      await waitForLockWaiters(sql, 1, 10_000, "%conversations%for update%");
      return { ingest, approval };
    });

    expect(await ingest).toMatchObject({ status: "created" });
    // The ingest committed first, so the approval finds the draft retired.
    await expect(approval).rejects.toBeInstanceOf(ConflictError);
    expect(seen.calls).toBe(0);
    expect(await one("select status from drafts where id = $1", [draft.id])).toMatchObject({ status: "stale" });
    expect(await count("send_attempts", f.org)).toBe(0);
  });

  it("raises drafts_one_in_flight_uq for a second in-flight draft, and an approval that meets it answers 409", async () => {
    const f = await fixture();
    const { draft } = await withDraft(f);
    const other = await twin(draft.id);
    const third = await twin(draft.id);

    // The index holds whatever path writes the status.
    await sql`update drafts set status = 'sending' where id = ${draft.id}`;
    await expect(sql`update drafts set status = 'delivery_uncertain' where id = ${other}`).rejects.toMatchObject({ code: "23505", constraint_name: "drafts_one_in_flight_uq" });
    await sql`update drafts set status = 'failed' where id = ${draft.id}`;

    // A writer that skips the conversation lock: the approval's check cannot see its uncommitted row, so the index refuses.
    const seen = watchMailer(f);
    let approval!: Promise<unknown>;
    await sql.begin(async (tx) => {
      await tx`update drafts set status = 'sending' where id = ${other}`;
      approval = mgmt.approveAndSendDraft(f.replyDeps, f.actor, third, { revision: 1, idempotencyKey: sendKey() });
      approval.catch(() => undefined);
      await waitForLockWaiters(sql, 1, 10_000, "%update%drafts%");
    });
    await expect(approval).rejects.toBeInstanceOf(ConflictError);
    await expect(approval).rejects.toThrow(STARTED_FIRST);
    expect(seen.calls).toBe(0);
    expect(await count("send_attempts", f.org)).toBe(0);
    expect(await one("select status from drafts where id = $1", [third])).toMatchObject({ status: "awaiting_review" });
  });

  it("names the draft's own status when the draft being approved is the one in flight", async () => {
    const f = await fixture();
    const { draft } = await withDraft(f);
    mailbox.behavior = () => "timeout-after-accept";
    await mgmt.approveAndSendDraft(f.replyDeps, f.actor, draft.id, { revision: draft.revision, idempotencyKey: sendKey() });
    mailbox.behavior = () => "ok";
    await expect(mgmt.approveAndSendDraft(f.replyDeps, f.actor, draft.id, { revision: draft.revision, idempotencyKey: sendKey() })).rejects.toThrow("This draft is delivery uncertain and cannot be sent.");
    await sql`update drafts set status = 'sending' where id = ${draft.id}`;
    await expect(mgmt.approveAndSendDraft(f.replyDeps, f.actor, draft.id, { revision: draft.revision, idempotencyKey: sendKey() })).rejects.toThrow("This draft is sending and cannot be sent.");
  });

  it("refuses a LinkedIn draft on the email path without waiting on its conversation", async () => {
    const f = await fixture();
    const { r } = await withDraft(f);
    const [chat] = await sql`
      insert into conversations (organization_id, record_id, channel, account_ref, provider_thread_id)
      select organization_id, record_id, 'linkedin', ${crypto.randomUUID()}, ${"chat-" + f.tag} from conversations where id = ${r.conversationId} returning id`;
    const [linkedin] = await sql`
      insert into drafts (organization_id, record_id, conversation_id, expected_context_version, channel, ai_body_text, status)
      select organization_id, record_id, ${chat.id}, 1, 'linkedin', 'Tuesday works.', 'awaiting_review' from conversations where id = ${chat.id}
      returning id`;
    // With the chat locked elsewhere, the refusal still comes at once: the email path takes no lock on it.
    await sql.begin(async (tx) => {
      await tx`select id from conversations where id = ${chat.id} for update`;
      await expect(mgmt.approveAndSendDraft(f.replyDeps, f.actor, linkedin.id, { revision: 1, idempotencyKey: sendKey() })).rejects.toThrow("This is not an email conversation.");
    });
  });

  it("resolves an uncertain send while the reconciler settles it, without a deadlock", async () => {
    const f = await fixture();
    const { draft } = await withDraft(f);
    mailbox.behavior = () => "timeout-after-accept";
    await mgmt.approveAndSendDraft(f.replyDeps, f.actor, draft.id, { revision: draft.revision, idempotencyKey: sendKey() });
    mailbox.behavior = () => "ok";
    f.state.offsetMs = 11 * 60_000;
    const [attempt] = await sql`select id from send_attempts where draft_id = ${draft.id}`;

    const { reconcile, resolve } = await sql.begin(async (tx) => {
      // Both queue on the attempt: the reconciler's settle first, then the person's answer. A resolve that locked the
      // draft before the attempt would hold what the settle needs next.
      await tx`select id from send_attempts where id = ${attempt.id} for update`;
      const reconcile = mgmt.reconcileReplies(f.replyDeps);
      reconcile.catch(() => undefined);
      await waitForLockWaiters(sql, 1, 10_000, "%send_attempts%for update%");
      const resolve = mgmt.resolveUncertainSend(f.replyDeps, f.actor, draft.id, { outcome: "delivered", note: "Found it in Sent" });
      resolve.catch(() => undefined);
      await waitForLockWaiters(sql, 2, 10_000, "%send_attempts%for update%");
      return { reconcile, resolve };
    });

    expect((await reconcile).found).toBeGreaterThanOrEqual(1);
    // The settle committed first, so the person's answer finds nothing left to resolve.
    await expect(resolve).rejects.toThrow("Only a send with an uncertain outcome can be resolved.");
    expect(await one("select status from send_attempts where id = $1", [attempt.id])).toMatchObject({ status: "reconciled" });
    expect(await one("select status from drafts where id = $1", [draft.id])).toMatchObject({ status: "sent" });
    expect(await count("messages", f.org, "direction = 'outbound'")).toBe(1);
  });
});
