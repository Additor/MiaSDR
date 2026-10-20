import { beforeAll, expect, it } from "vitest";
import { describeDb } from "@/test-support/db";
import { useReplyKit, type ReplyFixture, type ReplyModules } from "./replies-test-kit";

describeDb("email reply attempt status guard", () => {
  const { modules, fixture, one, count, receive, panel, sendKey } = useReplyKit();
  let stores: ReplyModules["stores"];
  type Fx = ReplyFixture;

  beforeAll(() => {
    ({ stores } = modules);
  });

  async function claimed(f: Fx) {
    const r = await receive(f);
    const p = await panel(f, r.conversationId);
    const draft = p.draft!;
    const started = await stores.replies.beginSend({ organizationId: f.org, draftId: draft.id, expectedRevision: draft.revision, idempotencyKey: sendKey(), actorUserId: f.user, messageIdToken: "tok-guard" });
    if (started.kind !== "started") throw new Error("claim did not start");
    return { send: started.send, draft };
  }
  const state = async (f: Fx) => ({
    attempt: (await one("select status, error from send_attempts where organization_id = $1", [f.org])) as unknown as { status: string; error: string | null },
    draft: (await one("select status from drafts where organization_id = $1 and status <> 'stale'", [f.org])).status as string,
  });
  const delivered = { providerMessageId: "pm-1", threadId: null };

  it("keeps a sent attempt and its draft sent when a late markFailed or markUncertain arrives", async () => {
    const f = await fixture();
    const { send } = await claimed(f);
    await stores.replies.markSent(send, delivered, new Date());
    await stores.replies.markFailed(send, "late failure", "awaiting_review");
    await stores.replies.markFailed(send, "late blocker", "failed");
    await stores.replies.markUncertain(send, "late timeout");
    const s = await state(f);
    expect(s.attempt).toMatchObject({ status: "sent", error: null });
    expect(s.draft).toBe("sent");
    expect(await count("messages", f.org, "direction = 'outbound'")).toBe(1);
  });

  it("keeps a reconciled attempt reconciled against late writers", async () => {
    const f = await fixture();
    const { send } = await claimed(f);
    await stores.replies.markUncertain(send, "timeout");
    await stores.replies.markSent(send, delivered, new Date(), "found in the Sent folder");
    await stores.replies.markFailed(send, "late failure", "awaiting_review");
    await stores.replies.markUncertain(send, "late timeout");
    const s = await state(f);
    expect(s.attempt.status).toBe("reconciled");
    expect(s.draft).toBe("sent");
  });

  it("leaves delivery_uncertain in place against a late definite failure", async () => {
    const f = await fixture();
    const { send } = await claimed(f);
    await stores.replies.markUncertain(send, "timeout");
    await stores.replies.markFailed(send, "late failure", "awaiting_review");
    await stores.replies.markUncertain(send, "again");
    const s = await state(f);
    expect(s.attempt.status).toBe("delivery_uncertain");
    expect(s.draft).toBe("delivery_uncertain");
  });

  it("settles delivery_uncertain through a person's answer only, and a failed attempt stays failed", async () => {
    const f = await fixture();
    const { send, draft } = await claimed(f);
    await stores.replies.markUncertain(send, "timeout");
    await stores.replies.resolveUncertain({ organizationId: f.org, draftId: draft.id, outcome: "not_delivered", note: "checked Sent", actorUserId: f.user, now: new Date() });
    await stores.replies.markSent(send, delivered, new Date());
    await stores.replies.markUncertain(send, "late timeout");
    const s = await state(f);
    expect(s.attempt.status).toBe("failed");
    expect(s.draft).toBe("failed");
    expect(await count("messages", f.org, "direction = 'outbound'")).toBe(0);
  });

  it("ends in one consistent state when settle and failure race", async () => {
    const f = await fixture();
    const { send } = await claimed(f);
    await Promise.all([stores.replies.markSent(send, delivered, new Date()), stores.replies.markFailed(send, "race", "awaiting_review"), stores.replies.markUncertain(send, "race")]);
    const s = await state(f);
    expect(["sent", "failed", "delivery_uncertain"]).toContain(s.attempt.status);
    expect(s.draft).toBe(s.attempt.status === "sent" ? "sent" : s.attempt.status === "failed" ? "awaiting_review" : "delivery_uncertain");
    expect(await count("messages", f.org, "direction = 'outbound'")).toBe(s.attempt.status === "sent" ? 1 : 0);
  });
});
