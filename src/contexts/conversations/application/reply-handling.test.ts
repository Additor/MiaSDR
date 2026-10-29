import { describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import {
  closeRecord,
  createReplyType,
  deleteReplyType,
  ignoreIdentityException,
  changeReplyType,
  quarantineInbound,
  reconcileSendAttempt,
  resolveIdentityException,
  setPersonDoNotContact,
  updateReplyType,
  type ReplyHandlingDeps,
  type IdentityPayload,
} from "./reply-handling";
import type { ReplyHandlingStore, IdentityExceptionIntake, IdentityExceptionRow, NewIdentityException, ReplyTypeRow } from "./reply-handling-ports";
import { DEFAULT_TYPE_RULES, STOP_REQUEST_RULES, SYSTEM_ROLE_REASONS } from "../domain/reply-type";
import type { ReplyDeps } from "./reply-management";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const actor: Actor = { userId: "33333333-3333-4333-8333-333333333333", organizationId: ORG, role: "member" };
const admin: Actor = { ...actor, role: "admin" };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = new Date("2026-01-01T00:00:00Z");

const sub = (over: Partial<ReplyTypeRow>): ReplyTypeRow => ({
  id: id(1), groupKey: "interested", key: "demo_request", name: "Demo request", description: null, classificationGuidance: null,
  active: true, rules: { ...DEFAULT_TYPE_RULES }, systemRole: null, sortOrder: 0, recordCount: 0, historyCount: 0, ...over,
});

/** In-memory store: only what the use cases under test touch. Everything else throws so a stray call fails loudly. */
function fakeStore(over: Partial<ReplyHandlingStore> & { subs?: ReplyTypeRow[]; exceptions?: IdentityExceptionRow[] } = {}) {
  const subs = over.subs ?? [];
  const exceptions = over.exceptions ?? [];
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, arg: unknown) => ((calls[name] ??= []).push(arg), arg);
  const store = {
    replyTypeCatalog: async (org: string) => ({ replyTypeSet: { id: id(90), name: "Default" }, replyTypes: org === ORG ? subs : [], settings: { autoApplyConfidence: 0.85, draftInstructions: [], classificationInstructions: [] } }),
    createReplyType: async (_org: string, input: unknown) => (record("createReplyType", input), { id: id(50) }),
    updateReplyType: async (_org: string, sid: string, patch: unknown) => void record("updateReplyType", { sid, patch }),
    deleteReplyType: async (_org: string, sid: string) => void record("deleteReplyType", sid),
    changeReplyType: async (input: { personId?: string }) => (record("changeReplyType", input), { recordId: id(2), personId: id(3), groupKey: "not_interested", replyTypeKey: "do_not_contact", contextVersion: 4, draftsRetired: 1, runStarted: false }),
    setDoNotContact: async (input: unknown) => (record("setDoNotContact", input), { changed: true, doNotContact: true, recordsUpdated: 1, draftsRetired: 0, enrollmentsStopped: 2 }),
    closeRecord: async (input: unknown) => void record("closeRecord", input),
    getIdentityException: async (org: string, eid: string) => exceptions.find((e) => e.id === eid && org === ORG) ?? null,
    personForReplay: async (org: string, pid: string) => (org === ORG && pid === id(7) ? { id: pid, email: "lead@acme.test" } : null),
    closeIdentityException: async (input: unknown) => (record("closeIdentityException", input), true),
    draftIdForAttempt: async (_org: string, aid: string) => (aid === id(8) ? id(9) : null),
    ...over,
  } as unknown as ReplyHandlingStore;
  return { store, calls };
}

function deps(store: ReplyHandlingStore) {
  const replayed: unknown[] = [];
  const d: ReplyHandlingDeps = {
    store,
    inbox: { list: vi.fn(), listScheduled: vi.fn(), filterOptions: vi.fn(), thread: vi.fn(), markRead: vi.fn() },
    now: () => NOW,
    replay: {
      email: async (input) => (replayed.push(input), { status: "created", conversationId: id(70), messageId: id(71), personId: input.personId ?? id(0), personCreated: false }),
      linkedin: async (input) => (replayed.push(input), { status: "created", conversationId: id(72), messageId: id(73), personId: input.personId ?? id(0), personCreated: false }),
    },
  };
  return { d, replayed };
}

describe("stage moves", () => {
  it("passes the change to the store and never sets do not contact, the stop request type included", async () => {
    const { store, calls } = fakeStore();
    const { d } = deps(store);
    const result = await changeReplyType(d, actor, id(2), { groupKey: "not_interested", replyTypeId: id(5), expectedContextVersion: 3, note: "  asked to stop  " });
    expect(result).toMatchObject({ contextVersion: 4, replyTypeKey: "do_not_contact" });
    expect(calls.changeReplyType[0]).toMatchObject({ organizationId: ORG, actorUserId: actor.userId, recordId: id(2), note: "asked to stop", confirmUnlock: false });
    expect(calls.setDoNotContact).toBeUndefined();
  });

  it("rejects bad input before the store is called", async () => {
    const { store, calls } = fakeStore();
    const { d } = deps(store);
    await expect(changeReplyType(d, actor, "nope", { groupKey: "other", replyTypeId: null, expectedContextVersion: 0 })).rejects.toThrow(NotFoundError);
    await expect(changeReplyType(d, actor, id(2), { groupKey: "won", replyTypeId: null, expectedContextVersion: 0 })).rejects.toThrow(ValidationError);
    await expect(changeReplyType(d, actor, id(2), { groupKey: "other", replyTypeId: null, expectedContextVersion: 0, occurredAt: new Date(NOW.getTime() + 3_600_000) })).rejects.toThrow(ConflictError);
    await expect(changeReplyType(d, actor, id(2), { groupKey: "other", replyTypeId: null, expectedContextVersion: 0, note: "x".repeat(4001) })).rejects.toThrow(ValidationError);
    expect(calls.changeReplyType).toBeUndefined();
  });
});

describe("do not contact", () => {
  it("needs a reason to set and defaults one to clear", async () => {
    const { store, calls } = fakeStore();
    const { d } = deps(store);
    await expect(setPersonDoNotContact(d, actor, id(3), { enabled: true, reason: "  " })).rejects.toThrow(ValidationError);
    await setPersonDoNotContact(d, actor, id(3), { enabled: true, reason: " asked by email " });
    await setPersonDoNotContact(d, actor, id(3), { enabled: false });
    expect(calls.setDoNotContact).toEqual([
      expect.objectContaining({ enabled: true, reason: "asked by email", organizationId: ORG, now: NOW }),
      expect.objectContaining({ enabled: false, reason: "Cleared by a person." }),
    ]);
  });
});

describe("close", () => {
  it("requires a reason", async () => {
    const { store, calls } = fakeStore();
    await expect(closeRecord(deps(store).d, actor, id(2), { reason: " " })).rejects.toThrow(ValidationError);
    await closeRecord(deps(store).d, actor, id(2), { reason: "Lost to a competitor" });
    expect(calls.closeRecord).toHaveLength(1);
  });
});

describe("taxonomy", () => {
  it("rejects a duplicate key and a duplicate name in the category", async () => {
    const { store, calls } = fakeStore({ subs: [sub({})] });
    const { d } = deps(store);
    await expect(createReplyType(d, admin, { groupKey: "interested", name: "Something else", key: "demo_request" })).rejects.toThrow(/already exists/);
    await expect(createReplyType(d, admin, { groupKey: "interested", name: "demo REQUEST" })).rejects.toThrow(/already exists/);
    await createReplyType(d, admin, { groupKey: "other", name: "Demo ask" });
    expect(calls.createReplyType).toHaveLength(1);
  });

  it("never archives or deletes a type with a system role, and says why", async () => {
    const dnc = sub({ id: id(4), key: "do_not_contact", groupKey: "not_interested", name: "Asked to stop", rules: { ...STOP_REQUEST_RULES }, systemRole: "stop_request" });
    const customer = sub({ id: id(6), key: "customer", groupKey: "customer", name: "Customer question", systemRole: "customer" });
    // The key alone carries no role: a type keyed do_not_contact without one archives like any other.
    const plain = sub({ id: id(7), key: "do_not_contact_old", name: "Old stop" });
    const { store, calls } = fakeStore({ subs: [dnc, customer, plain] });
    const { d } = deps(store);
    for (const [tid, role] of [[id(4), "stop_request"], [id(6), "customer"]] as const) {
      await expect(updateReplyType(d, admin, tid, { active: false })).rejects.toThrow(SYSTEM_ROLE_REASONS[role]);
      await expect(deleteReplyType(d, admin, tid)).rejects.toThrow(SYSTEM_ROLE_REASONS[role]);
    }
    await expect(updateReplyType(d, admin, id(4), { name: "Stop" })).resolves.toBeUndefined();
    await updateReplyType(d, admin, id(7), { active: false });
    expect(calls.deleteReplyType).toBeUndefined();
  });

  it("merges the rules a change names with the stored ones and checks them against the system role", async () => {
    const dnc = sub({ id: id(4), key: "do_not_contact", groupKey: "not_interested", name: "Asked to stop", rules: { ...STOP_REQUEST_RULES }, systemRole: "stop_request" });
    const plain = sub({ id: id(5), key: "pricing", name: "Pricing" });
    const { store, calls } = fakeStore({ subs: [dnc, plain] });
    const { d } = deps(store);
    await expect(updateReplyType(d, admin, id(4), { replyDraft: true })).rejects.toThrow(/never gets a reply draft/);
    await expect(updateReplyType(d, admin, id(4), { checkMode: "skip" })).rejects.toThrow(/checked before/);
    await updateReplyType(d, admin, id(5), { followUps: "stop" });
    expect(calls.updateReplyType).toEqual([{ sid: id(5), patch: { rules: { checkMode: "after", replyDraft: true, followUps: "stop" } } }]);
  });

  it("blocks a delete while records or history use the subcategory", async () => {
    const used = sub({ id: id(5), recordCount: 2 });
    const past = sub({ id: id(6), key: "old", name: "Old", historyCount: 3 });
    const free = sub({ id: id(10), key: "free", name: "Free" });
    const { store, calls } = fakeStore({ subs: [used, past, free] });
    const { d } = deps(store);
    await expect(deleteReplyType(d, admin, id(5))).rejects.toThrow(/2 people have/);
    await expect(deleteReplyType(d, admin, id(6))).rejects.toThrow(/Archive it/);
    await deleteReplyType(d, admin, id(10));
    expect(calls.deleteReplyType).toEqual([id(10)]);
  });

  it("refuses a member", async () => {
    const { d } = deps(fakeStore({ subs: [sub({ id: id(5) })] }).store);
    await expect(createReplyType(d, actor, { groupKey: "other", name: "Demo ask" })).rejects.toThrow(ForbiddenError);
    await expect(updateReplyType(d, actor, id(5), { active: false })).rejects.toThrow(ForbiddenError);
    await expect(deleteReplyType(d, actor, id(5))).rejects.toThrow(ForbiddenError);
  });

  it("answers 404 for a subcategory of another organization", async () => {
    const other: Actor = { ...admin, organizationId: OTHER_ORG };
    const { d } = deps(fakeStore({ subs: [sub({ id: id(5) })] }).store);
    await expect(deleteReplyType(d, other, id(5))).rejects.toThrow(NotFoundError);
    await expect(updateReplyType(d, other, id(5), { active: false })).rejects.toThrow(NotFoundError);
  });
});

describe("reconciling an uncertain reply", () => {
  it("resolves through the existing reply use case and never sends", async () => {
    const resolveUncertain = vi.fn(async () => undefined);
    const send = vi.fn();
    const reply = { store: { resolveUncertain }, mailer: { send, findSent: vi.fn() }, now: () => NOW } as unknown as ReplyDeps;
    const { d } = deps(fakeStore().store);
    await reconcileSendAttempt(d, reply, actor, id(8), { delivered: false, note: "Checked the Sent folder" });
    expect(resolveUncertain).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, draftId: id(9), outcome: "not_delivered", note: "Checked the Sent folder" }));
    expect(send).not.toHaveBeenCalled();
    await expect(reconcileSendAttempt(d, reply, actor, id(12), { delivered: true, note: "x" })).rejects.toThrow(NotFoundError);
    await expect(reconcileSendAttempt(d, reply, actor, id(8), { delivered: true, note: " " })).rejects.toThrow(ValidationError);
  });
});

describe("identity exceptions", () => {
  const email: IdentityPayload = {
    kind: "email",
    message: { accountRef: "me@corp.test", providerThreadId: "t1", providerMessageId: "m1", rfcMessageId: null, inReplyTo: null, from: { email: "colleague@acme.test", name: "Col League" }, to: ["me@corp.test"], subject: "Re: hi", bodyText: "Pass to Pat.", receivedAt: "2026-01-01T00:00:00.000Z", autoReply: false },
  };
  const row = (over: Partial<IdentityExceptionRow> = {}): IdentityExceptionRow => ({
    id: id(20), channel: "email", accountRef: "me@corp.test", sourceEventKey: "k1", identityValue: "colleague@acme.test", reason: "Sender does not match the lead", status: "open", payload: email, resolvedPersonId: null, resolvedAt: null, createdAt: NOW, ...over,
  });

  it("replays the payload under the chosen person and the actor's organization, then closes the exception", async () => {
    const { store, calls } = fakeStore({ exceptions: [row({ payload: { ...email, message: { ...email.message, organizationId: OTHER_ORG } } })] });
    const { d, replayed } = deps(store);
    const result = await resolveIdentityException(d, actor, id(20), { personId: id(7) });
    expect(result.conversationId).toBe(id(70));
    expect(replayed[0]).toMatchObject({ organizationId: ORG, personId: id(7), providerMessageId: "m1" });
    expect((replayed[0] as { receivedAt: Date }).receivedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(calls.closeIdentityException[0]).toMatchObject({ organizationId: ORG, id: id(20), outcome: { status: "resolved", personId: id(7) } });
  });

  it("replays a LinkedIn message through the LinkedIn path", async () => {
    const linkedin: IdentityPayload = { kind: "linkedin", message: { accountRef: "acc", accountName: "Me", providerThreadId: "c1", providerMessageId: "lm1", counterparty: { providerId: "p1", name: "Pat", profileUrl: null, slug: null }, bodyText: "hello", receivedAt: "2026-01-02T00:00:00.000Z" } };
    const { d, replayed } = deps(fakeStore({ exceptions: [row({ channel: "linkedin", payload: linkedin })] }).store);
    await resolveIdentityException(d, actor, id(20), { personId: id(7) });
    expect(replayed[0]).toMatchObject({ organizationId: ORG, personId: id(7), providerThreadId: "c1" });
  });

  it("refuses a person of another organization, a reviewed exception and an unreadable payload", async () => {
    const { d, replayed } = deps(fakeStore({ exceptions: [row(), row({ id: id(21), status: "ignored" }), row({ id: id(22), payload: { oops: true } })] }).store);
    await expect(resolveIdentityException(d, actor, id(20), { personId: id(99) })).rejects.toThrow(NotFoundError);
    await expect(resolveIdentityException(d, actor, id(21), { personId: id(7) })).rejects.toThrow(/already reviewed/);
    await expect(resolveIdentityException(d, actor, id(22), { personId: id(7) })).rejects.toThrow(/cannot be replayed/);
    await expect(resolveIdentityException(d, { ...actor, organizationId: OTHER_ORG }, id(20), { personId: id(7) })).rejects.toThrow(NotFoundError);
    expect(replayed).toHaveLength(0);
  });

  it("ignores an open exception without replaying", async () => {
    const { store, calls } = fakeStore({ exceptions: [row()] });
    const { d, replayed } = deps(store);
    await ignoreIdentityException(d, actor, id(20));
    expect(calls.closeIdentityException[0]).toMatchObject({ outcome: { status: "ignored" } });
    expect(replayed).toHaveLength(0);
  });

  it("quarantines a message under the channel and account of its payload", async () => {
    const inserted: NewIdentityException[] = [];
    const exceptions: IdentityExceptionIntake = { insertIdentityException: async (input) => (inserted.push(input), { id: id(60), created: true }) };
    await quarantineInbound({ exceptions }, { organizationId: ORG, sourceEventKey: " gmail:m1 ", identityValue: "colleague@acme.test", reason: "Sender does not match the lead", payload: email });
    expect(inserted[0]).toMatchObject({ organizationId: ORG, channel: "email", accountRef: "me@corp.test", sourceEventKey: "gmail:m1" });
    await expect(quarantineInbound({ exceptions }, { organizationId: ORG, sourceEventKey: "k", identityValue: null, reason: " ", payload: email })).rejects.toThrow(ValidationError);
  });
});
