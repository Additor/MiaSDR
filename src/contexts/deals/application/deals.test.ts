import { describe, expect, it } from "vitest";
import { lockRetryStats } from "@/platform/db/errors";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import type { LiveEnrollmentSummary } from "@/contexts/outreach/application/conversion";
import { DEFAULT_DEAL_STAGES } from "../domain/stages";
import type { AuditEntry, DealPerson, DealRow, DealsDeps, DealStage, NewDeal } from "./deal-ports";
import { createDealStage, createDefaultDealStages, deleteDealStage, listDealStages, renameDealStage, reorderDealStages } from "./deal-stages";
import { board, createDealForContact, createDealFromLead, createDealsFromLeads, deleteDeal, moveDealStage, updateDeal } from "./deals";

/*
 * The deals use cases against in-memory ports. The unit of work snapshots the state and restores it when the callback throws,
 * so "all or nothing" is observable here; the Postgres behavior (locks, triggers, races) is in deals.integration.test.ts.
 */

const ORG = "00000000-0000-4000-8000-0000000000aa";
const OWNER = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";
const OTHER_MEMBER = "00000000-0000-4000-8000-000000000003";
const STRANGER = "00000000-0000-4000-8000-000000000009";
const admin: Actor = { userId: OWNER, organizationId: ORG, role: "owner" };
const member: Actor = { userId: MEMBER, organizationId: ORG, role: "member" };
const NOW = new Date("2026-10-16T12:00:00Z");

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0").replace(/^0{2}/, "1f")}`;

interface State {
  stages: DealStage[];
  deals: Array<DealRow & { organizationId: string; idempotencyKey: string | null }>;
  events: Array<{ eventType: string; personId: string; meta: unknown }>;
  audits: AuditEntry[];
  lifecycle: Record<string, "lead" | "contact">;
}

function world() {
  let state: State = { stages: [], deals: [], events: [], audits: [], lifecycle: {} };
  const people = new Map<string, DealPerson>();
  const live = new Map<string, LiveEnrollmentSummary>();
  const control = {
    convertFailures: [] as string[],
    insertFails: false,
    stopped: { enrollments: 2, runs: 1, drafts: 1 },
    replied: new Map<string, string>(),
    lockCalls: 0,
  };
  const addPerson = (over: Partial<DealPerson> = {}) => {
    const id = uuid();
    people.set(id, { id, name: "Ada Lovelace", email: `${id}@x.test`, linkedinSlug: null, linkedinUrl: null, title: null, companyId: null, companyName: "Analytical", lifecycle: "lead", convertedAt: null, doNotContact: false, suppressed: false, ...over });
    state.lifecycle[id] = (over.lifecycle as "lead" | "contact") ?? "lead";
    return id;
  };
  const seedDefaults = () => {
    if (state.stages.length === 0) state.stages = DEFAULT_DEAL_STAGES.map((s) => ({ ...s, id: uuid() }));
    return [...state.stages].sort((a, b) => a.position - b.position);
  };
  const sorted = () => [...state.stages].sort((a, b) => a.position - b.position);
  const deps: DealsDeps = {
    uow: {
      async run(fn) {
        const snapshot = structuredClone(state);
        try {
          return await fn({} as never);
        } catch (error) {
          state = snapshot;
          throw error;
        }
      },
    },
    store: {
      ensureStages: async () => seedDefaults(),
      listStages: async () => sorted(),
      stageDealCounts: async () => {
        const counts = new Map<string, number>();
        for (const d of state.deals) counts.set(d.stageId, (counts.get(d.stageId) ?? 0) + 1);
        return counts;
      },
      byIdempotencyKey: async (_tx, org, personId, key) => {
        const deal = state.deals.find((d) => d.organizationId === org && d.personId === personId && d.idempotencyKey === key);
        if (!deal) return null;
        const event = state.events.find((e) => e.eventType === "deal.created" && (e.meta as { dealId: string }).dealId === deal.id) as { meta: { stopped?: never } } | undefined;
        return { dealId: deal.id, stopped: event?.meta.stopped ?? { enrollments: 0, runs: 0, drafts: 0 } };
      },
      primaryDealIdOfPerson: async (_tx, _org, personId) => state.deals.filter((d) => d.personId === personId).at(-1)?.id ?? null,
      insert: async (_tx, deal: NewDeal) => {
        if (control.insertFails) throw new Error("insert failed");
        if (deal.idempotencyKey && state.deals.some((d) => d.personId === deal.personId && d.idempotencyKey === deal.idempotencyKey)) return null;
        const row = { ...deal, id: uuid(), version: 0, createdAt: NOW, updatedAt: NOW };
        state.deals.push(row);
        return row;
      },
      lock: async (_tx, org, dealId) => state.deals.find((d) => d.organizationId === org && d.id === dealId) ?? null,
      update: async (_tx, _org, dealId, patch) => {
        const deal = state.deals.find((d) => d.id === dealId)!;
        Object.assign(deal, patch, { version: deal.version + 1 });
        return deal;
      },
      delete: async (_tx, _org, dealId) => {
        state.deals = state.deals.filter((d) => d.id !== dealId);
      },
      lockStages: async () => sorted(),
      insertStage: async (_tx, _org, stage) => {
        const row = { ...stage, id: uuid() };
        state.stages.push(row);
        return row;
      },
      renameStage: async (_tx, _org, id, name) => {
        state.stages.find((s) => s.id === id)!.name = name;
      },
      setPositions: async (_tx, _org, positions) => {
        for (const p of positions) state.stages.find((s) => s.id === p.id)!.position = p.position;
      },
      deleteStage: async (_tx, _org, id) => {
        state.stages = state.stages.filter((s) => s.id !== id);
      },
      audit: async (_tx, entry) => void state.audits.push(entry),
    },
    convertLead: async (_tx, input) => {
      control.lockCalls += 1;
      const failure = control.convertFailures.shift();
      if (failure) throw Object.assign(new Error(`lock failure ${failure}`), { cause: { code: failure } });
      const lifecycle = state.lifecycle[input.personId];
      if (!lifecycle) throw new NotFoundError("Lead not found");
      if (lifecycle === "contact") return { changed: false, stopped: { enrollments: 0, runs: 0, drafts: 0 } };
      if (input.guard) await input.guard(_tx);
      state.lifecycle[input.personId] = "contact";
      return { changed: true, stopped: { ...control.stopped } };
    },
    people: { summaries: async (_org, ids) => new Map(ids.filter((id) => people.has(id)).map((id) => [id, { ...people.get(id)!, lifecycle: state.lifecycle[id] }])) },
    outreach: {
      liveEnrollmentSummary: async (_org, ids) => new Map(ids.map((id) => [id, live.get(id) ?? { regular: 0, personal: { count: 0, createdBy: [] } }])),
      latestRepliedEnrollment: async (_org, ids) => new Map(ids.filter((id) => control.replied.has(id)).map((id) => [id, control.replied.get(id)!])),
      enrollmentSources: async () => new Map(),
    },
    events: { append: async (_tx, input) => void state.events.push({ eventType: input.eventType, personId: input.personId, meta: input.meta }) },
    members: {
      isMember: async (_org, userId) => [OWNER, MEMBER, OTHER_MEMBER].includes(userId),
      names: async () => new Map([[OWNER, "Owner"], [MEMBER, "Member"], [OTHER_MEMBER, "Other"]]),
    },
    crm: {
      board: async (_org, query) => query.stageIds.map((stageId) => ({ stageId, total: 0, amounts: [], cards: [], nextCursor: null })),
      deal: async (_org, dealId) => {
        const d = state.deals.find((x) => x.id === dealId);
        const s = d && state.stages.find((x) => x.id === d.stageId);
        return d && s ? { ...d, stageName: s.name, stagePosition: s.position } : null;
      },
      dealsOfPeople: async () => [],
      dealsOfCompany: async () => [],
      contacts: async () => ({ rows: [], total: 0 }),
      companies: async () => ({ rows: [], total: 0 }),
      company: async () => null,
      contactsOfCompany: async () => [],
      companySummaries: async () => new Map(),
      openAmounts: async () => new Map(),
      contactIds: async () => ({ ids: [], total: 0 }),
      contactExportColumns: async () => [],
      contactsForExport: async function* () {},
    },
    now: () => NOW,
  };
  return { deps, addPerson, live, control, state: () => state, seedDefaults };
}

const expectConflict = async (run: Promise<unknown>, code: string) => {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ConflictError);
  expect((error as ConflictError).details?.code).toBe(code);
  return error as ConflictError;
};

describe("createDealFromLead", () => {
  it("converts the lead and creates the deal in one unit, with the defaults and the effects the conversion reported", async () => {
    const w = world();
    const person = w.addPerson();
    w.control.replied.set(person, "00000000-0000-4000-8000-0000000000e1");
    const result = await createDealFromLead(w.deps, admin, person);
    expect(result).toMatchObject({ replayed: false, stopped: { enrollments: 2, runs: 1, drafts: 1 } });
    const [deal] = w.state().deals;
    const first = w.state().stages.find((s) => s.name === "New")!;
    expect(deal).toMatchObject({ id: result.dealId, personId: person, title: "Analytical, Ada Lovelace", stageId: first.id, stageKind: "open", ownerUserId: OWNER, closedAt: null, stageChangedAt: NOW, sourceEnrollmentId: "00000000-0000-4000-8000-0000000000e1", createdBy: OWNER });
    expect(w.state().lifecycle[person]).toBe("contact");
    expect(w.state().events).toEqual([{ eventType: "deal.created", personId: person, meta: expect.objectContaining({ dealId: result.dealId, stopped: result.stopped }) }]);
  });

  it("rolls the conversion back when the deal insert fails", async () => {
    const w = world();
    const person = w.addPerson();
    w.control.insertFails = true;
    await expect(createDealFromLead(w.deps, admin, person)).rejects.toThrow("insert failed");
    expect(w.state().lifecycle[person]).toBe("lead");
    expect(w.state().deals).toEqual([]);
  });

  it("replays the first result for the same key and answers already_converted without one", async () => {
    const w = world();
    const person = w.addPerson();
    const first = await createDealFromLead(w.deps, admin, person, { idempotencyKey: "dialog-1" });
    const again = await createDealFromLead(w.deps, admin, person, { idempotencyKey: "dialog-1" });
    expect(again).toEqual({ ...first, replayed: true });
    const conflict = await expectConflict(createDealFromLead(w.deps, admin, person), "already_converted");
    expect(conflict.details?.dealId).toBe(first.dealId);
    expect(w.state().deals).toHaveLength(1);
  });

  it("already_converted carries null for a contact without a deal", async () => {
    const w = world();
    const person = w.addPerson({ lifecycle: "contact" });
    const conflict = await expectConflict(createDealFromLead(w.deps, admin, person), "already_converted");
    expect(conflict.details?.dealId).toBeNull();
  });

  it("answers 404 for an unknown or malformed person", async () => {
    const w = world();
    await expect(createDealFromLead(w.deps, admin, "00000000-0000-4000-8000-00000000dead")).rejects.toBeInstanceOf(NotFoundError);
    await expect(createDealFromLead(w.deps, admin, "nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses an owner outside the organization, a bad amount, an unknown currency and a stage of no pipeline", async () => {
    const w = world();
    const person = w.addPerson();
    const invalid = (input: Parameters<typeof createDealFromLead>[3]) => expect(createDealFromLead(w.deps, admin, person, input)).rejects.toBeInstanceOf(ValidationError);
    await invalid({ ownerId: STRANGER });
    await invalid({ ownerId: "not-a-uuid" });
    await invalid({ amount: "100" });
    await invalid({ amount: "-1", currency: "USD" });
    await invalid({ amount: "1", currency: "XYZ" });
    await invalid({ amount: "1.5", currency: "KRW" });
    await invalid({ stageId: "00000000-0000-4000-8000-00000000beef" });
    await invalid({ stageId: "nope" });
    await invalid({ expectedCloseOn: "2026-02-30" });
    const lost = w.seedDefaults().find((s) => s.kind === "lost")!;
    await invalid({ stageId: lost.id });
    expect(w.state().lifecycle[person]).toBe("lead");
    const ok = await createDealFromLead(w.deps, admin, person, { ownerId: null, amount: "1,250.50", currency: "usd", expectedCloseOn: "2026-12-01", title: "Renewal" });
    expect(w.state().deals.find((d) => d.id === ok.dealId)).toMatchObject({ ownerUserId: null, amountMinor: 125050, currency: "USD", expectedCloseOn: "2026-12-01", title: "Renewal" });
  });

  it("skips a person held by another member's personal campaign, converts for its creator or an admin", async () => {
    const w = world();
    const held = w.addPerson();
    w.live.set(held, { regular: 1, personal: { count: 1, createdBy: [OTHER_MEMBER] } });
    const error = await createDealFromLead(w.deps, member, held).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(w.state().lifecycle[held]).toBe("lead");
    const creator: Actor = { userId: OTHER_MEMBER, organizationId: ORG, role: "member" };
    await createDealFromLead(w.deps, creator, held);
    const other = w.addPerson();
    w.live.set(other, { regular: 0, personal: { count: 1, createdBy: [OTHER_MEMBER] } });
    await createDealFromLead(w.deps, admin, other);
    expect(w.state().lifecycle[other]).toBe("contact");
  });

  it("retries once on a deadlock or lock timeout, then answers try_again", async () => {
    const w = world();
    const person = w.addPerson();
    const before = lockRetryStats.retries;
    w.control.convertFailures.push("40P01");
    await createDealFromLead(w.deps, admin, person);
    expect(lockRetryStats.retries).toBe(before + 1);
    const next = w.addPerson();
    w.control.convertFailures.push("55P03", "40P01");
    await expectConflict(createDealFromLead(w.deps, admin, next), "try_again");
    expect(w.state().lifecycle[next]).toBe("lead");
    w.control.convertFailures.push("23505");
    await expect(createDealFromLead(w.deps, admin, next)).rejects.toThrow("lock failure 23505");
  });
});

describe("createDealsFromLeads", () => {
  it("reports created and skipped per person; one failure leaves the others; a second deadlock is retryable", async () => {
    const w = world();
    const a = w.addPerson();
    const contact = w.addPerson({ lifecycle: "contact" });
    const held = w.addPerson();
    w.live.set(held, { regular: 0, personal: { count: 1, createdBy: [OTHER_MEMBER] } });
    const flaky = w.addPerson();
    const b = w.addPerson();
    const missing = "00000000-0000-4000-8000-00000000dead";
    // a converts; held is skipped before convertLead; flaky meets two deadlocks; b converts after them.
    const order = [a, held, flaky, b];
    let calls = 0;
    const convert = w.deps.convertLead;
    w.deps.convertLead = async (tx, input) => {
      calls += 1;
      if (input.personId === flaky) throw Object.assign(new Error("deadlock"), { code: "40P01" });
      return convert(tx, input);
    };
    const result = await createDealsFromLeads(w.deps, member, [...order, contact, missing, "garbage", a]);
    expect(result.created.map((c) => c.personId)).toEqual([a, b]);
    expect(result.skipped).toEqual([
      { personId: held, reason: "personal_campaign" },
      { personId: flaky, reason: "retryable" },
      { personId: contact, reason: "already_converted" },
      { personId: missing, reason: "not_found" },
      { personId: "garbage", reason: "not_found" },
    ]);
    expect(calls).toBe(4);
    expect(w.state().deals.map((d) => d.personId)).toEqual([a, b]);
  });

  it("takes at most 200 ids and checks the stage and owner once", async () => {
    const w = world();
    await expect(createDealsFromLeads(w.deps, admin, Array.from({ length: 201 }, (_, i) => `id-${i}`))).rejects.toThrow("Create deals for up to 200 leads per request.");
    expect((await createDealsFromLeads(w.deps, admin, Array.from({ length: 200 }, (_, i) => `id-${i}`))).skipped).toHaveLength(200);
    await expect(createDealsFromLeads(w.deps, admin, [w.addPerson()], { stageId: "00000000-0000-4000-8000-00000000beef" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createDealsFromLeads(w.deps, admin, [w.addPerson()], { ownerId: STRANGER })).rejects.toBeInstanceOf(ValidationError);
    expect(await createDealsFromLeads(w.deps, admin, [])).toEqual({ created: [], skipped: [] });
  });

  it("refuses a Lost stage up front, before any person converts", async () => {
    const w = world();
    const lost = w.seedDefaults().find((s) => s.kind === "lost")!;
    const a = w.addPerson();
    const error = await createDealsFromLeads(w.deps, admin, [a], { stageId: lost.id }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toContain("Bulk cannot start deals in a Lost stage");
    expect(w.control.lockCalls).toBe(0);
    expect(w.state().lifecycle[a]).toBe("lead");
  });

  it("returns the ids it did not reach within the time budget as retryable", async () => {
    const w = world();
    const ids = [w.addPerson(), w.addPerson(), w.addPerson(), w.addPerson()];
    let clock = NOW.getTime();
    w.deps.now = () => new Date(clock);
    const convert = w.deps.convertLead;
    // Each conversion takes 8 s on the injected clock: the first three start inside 20 s, the fourth after it.
    w.deps.convertLead = async (tx, input) => {
      clock += 8_000;
      return convert(tx, input);
    };
    const result = await createDealsFromLeads(w.deps, admin, ids);
    expect(result.created.map((c) => c.personId)).toEqual(ids.slice(0, 3));
    expect(result.skipped).toEqual([{ personId: ids[3], reason: "retryable" }]);
    expect(w.state().lifecycle[ids[3]]).toBe("lead");
  });

  it("an unexpected error reports failed and the batch goes on", async () => {
    const w = world();
    const a = w.addPerson();
    const b = w.addPerson();
    const insert = w.deps.store.insert;
    w.deps.store.insert = async (tx, deal) => {
      if (deal.personId === a) throw new Error("boom");
      return insert(tx, deal);
    };
    const result = await createDealsFromLeads(w.deps, admin, [a, b]);
    expect(result.skipped).toEqual([{ personId: a, reason: "failed" }]);
    expect(result.created.map((c) => c.personId)).toEqual([b]);
    expect(w.state().lifecycle[a]).toBe("lead");
  });
});

describe("createDealForContact", () => {
  it("needs a contact and a key; the same key creates one deal", async () => {
    const w = world();
    const lead = w.addPerson();
    const contact = w.addPerson({ lifecycle: "contact" });
    await expect(createDealForContact(w.deps, admin, lead, { idempotencyKey: "k1" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createDealForContact(w.deps, admin, contact, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(createDealForContact(w.deps, admin, "00000000-0000-4000-8000-00000000dead", { idempotencyKey: "k1" })).rejects.toBeInstanceOf(NotFoundError);
    const first = await createDealForContact(w.deps, admin, contact, { idempotencyKey: "k1", title: "Expansion" });
    const again = await createDealForContact(w.deps, admin, contact, { idempotencyKey: "k1", title: "Expansion" });
    expect(again).toEqual({ dealId: first.dealId, replayed: true });
    expect(w.state().deals).toHaveLength(1);
    expect(w.state().deals[0]).toMatchObject({ sourceEnrollmentId: null, title: "Expansion" });
    expect(w.control.lockCalls).toBe(0);
  });
});

describe("moveDealStage, updateDeal, deleteDeal", () => {
  async function dealIn() {
    const w = world();
    const person = w.addPerson();
    const { dealId } = await createDealFromLead(w.deps, admin, person);
    const stages = w.state().stages;
    const by = (name: string) => stages.find((s) => s.name === name)!;
    let clock = NOW;
    w.deps.now = () => clock;
    return { w, dealId, by, tick: (ms: number) => (clock = new Date(clock.getTime() + ms)), deal: () => w.state().deals.find((d) => d.id === dealId)! };
  }

  it("needs the current version and a lost reason; out of lost clears it; back to open clears closed_at", async () => {
    const { w, dealId, by, tick, deal } = await dealIn();
    await expectConflict(moveDealStage(w.deps, admin, dealId, { stageId: by("Meeting").id, expectedVersion: 3 }), "stale_version");
    await expect(moveDealStage(w.deps, admin, dealId, { stageId: by("Lost").id, expectedVersion: 0 })).rejects.toBeInstanceOf(ValidationError);
    tick(1000);
    const lost = await moveDealStage(w.deps, admin, dealId, { stageId: by("Lost").id, expectedVersion: 0, lostReason: "No budget" });
    expect(lost).toMatchObject({ version: 1, lostReason: "No budget", stage: { name: "Lost", kind: "lost" } });
    expect(deal().closedAt?.toISOString()).toBe("2026-10-16T12:00:01.000Z");
    tick(1000);
    await moveDealStage(w.deps, admin, dealId, { stageId: by("Won").id, expectedVersion: 1 });
    expect(deal()).toMatchObject({ lostReason: null, stageKind: "won" });
    tick(1000);
    await moveDealStage(w.deps, admin, dealId, { stageId: by("Proposal").id, expectedVersion: 2 });
    expect(deal()).toMatchObject({ closedAt: null, stageKind: "open", version: 3 });
    expect(deal().stageChangedAt.toISOString()).toBe("2026-10-16T12:00:03.000Z");
    expect(w.state().events.filter((e) => e.eventType === "deal.stage_moved")).toHaveLength(3);
  });

  it("stage_changed_at changes only on a move", async () => {
    const { w, dealId, by, tick, deal } = await dealIn();
    tick(5000);
    await moveDealStage(w.deps, admin, dealId, { stageId: by("New").id, expectedVersion: 0 });
    expect(deal()).toMatchObject({ version: 0, stageChangedAt: NOW });
    await updateDeal(w.deps, admin, dealId, { expectedVersion: 0, title: "Renamed", amount: "10", currency: "EUR" });
    expect(deal()).toMatchObject({ version: 1, title: "Renamed", amountMinor: 1000, currency: "EUR", stageChangedAt: NOW });
  });

  it("updateDeal validates the owner and the amount pair, and checks the version", async () => {
    const { w, dealId, deal } = await dealIn();
    await expect(updateDeal(w.deps, admin, dealId, { expectedVersion: 0, ownerId: STRANGER })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateDeal(w.deps, admin, dealId, { expectedVersion: 0, currency: "EUR" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateDeal(w.deps, admin, dealId, { expectedVersion: 0, amount: "5" })).rejects.toBeInstanceOf(ValidationError);
    await expectConflict(updateDeal(w.deps, admin, dealId, { expectedVersion: 9, title: "x" }), "stale_version");
    await updateDeal(w.deps, admin, dealId, { expectedVersion: 0, amount: "5", currency: "KWD" });
    await updateDeal(w.deps, admin, dealId, { expectedVersion: 1, amount: "7" });
    expect(deal()).toMatchObject({ amountMinor: 7000, currency: "KWD" });
    await updateDeal(w.deps, admin, dealId, { expectedVersion: 2, amount: null });
    expect(deal()).toMatchObject({ amountMinor: null, currency: null });
    await expect(updateDeal(w.deps, admin, "00000000-0000-4000-8000-00000000dead", { expectedVersion: 0 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deletes only an open deal; the person stays a contact", async () => {
    const { w, dealId, by } = await dealIn();
    const person = w.state().deals[0].personId;
    await moveDealStage(w.deps, admin, dealId, { stageId: by("Won").id, expectedVersion: 0 });
    await expectConflict(deleteDeal(w.deps, admin, dealId), "deal_closed");
    await moveDealStage(w.deps, admin, dealId, { stageId: by("New").id, expectedVersion: 1 });
    await expectConflict(deleteDeal(w.deps, admin, dealId, { expectedVersion: 0 }), "stale_version");
    await deleteDeal(w.deps, admin, dealId, { expectedVersion: 2 });
    expect(w.state().deals).toEqual([]);
    expect(w.state().lifecycle[person]).toBe("contact");
    expect(w.state().events.at(-1)).toMatchObject({ eventType: "deal.deleted" });
  });
});

describe("stage settings", () => {
  it("lists the defaults as virtual without writing; the first write creates them", async () => {
    const w = world();
    const listed = await listDealStages(w.deps, admin);
    expect(listed.virtual).toBe(true);
    expect(listed.stages.map((s) => [s.id, s.name])).toEqual(DEFAULT_DEAL_STAGES.map((s) => [null, s.name]));
    expect(w.state().stages).toEqual([]);
    expect((await board(w.deps, admin)).virtual).toBe(true);
    const created = await createDealStage(w.deps, admin, { name: "Demo", kind: "open" });
    expect(created.virtual).toBe(false);
    expect(created.stages.map((s) => [s.name, s.position])).toEqual([["New", 1], ["Meeting", 2], ["Proposal", 3], ["Demo", 4], ["Won", 5], ["Lost", 6]]);
    expect(w.state().audits.map((a) => a.action)).toEqual(["deal_stage.created"]);
  });

  it("Create default stages writes the defaults once and leaves an existing pipeline alone", async () => {
    const w = world();
    const created = await createDefaultDealStages(w.deps, admin);
    expect(created.virtual).toBe(false);
    expect(created.stages.map((s) => s.name)).toEqual(DEFAULT_DEAL_STAGES.map((s) => s.name));
    const again = await createDefaultDealStages(w.deps, admin);
    expect(again.stages.map((s) => s.id)).toEqual(created.stages.map((s) => s.id));
    expect(w.state().audits.map((a) => a.action)).toEqual(["deal_stage.defaults_created"]);
  });

  it("refuses a duplicate name, keeps the kind order on reorder, and audits each write", async () => {
    const w = world();
    const stages = w.seedDefaults();
    await expectConflict(createDealStage(w.deps, admin, { name: "new", kind: "open" }), "name_taken");
    await expect(createDealStage(w.deps, admin, { name: "X", kind: "closed" })).rejects.toBeInstanceOf(ValidationError);
    await expectConflict(renameDealStage(w.deps, admin, stages[0].id, { name: "MEETING" }), "name_taken");
    await renameDealStage(w.deps, admin, stages[0].id, { name: "Inbound" });
    const ids = stages.map((s) => s.id);
    await expect(reorderDealStages(w.deps, admin, [ids[3], ids[0], ids[1], ids[2], ids[4]])).rejects.toThrow("Open stages come first");
    const reordered = await reorderDealStages(w.deps, admin, [ids[2], ids[0], ids[1], ids[3], ids[4]]);
    expect(reordered.stages.map((s) => s.id)).toEqual([ids[2], ids[0], ids[1], ids[3], ids[4]]);
    expect(w.state().audits.map((a) => a.action)).toEqual(["deal_stage.renamed", "deal_stage.reordered"]);
  });

  it("refuses to delete a stage with deals (with the count) or the last of its kind", async () => {
    const w = world();
    const stages = w.seedDefaults();
    await createDealFromLead(w.deps, admin, w.addPerson());
    await createDealFromLead(w.deps, admin, w.addPerson());
    const inUse = await expectConflict(deleteDealStage(w.deps, admin, stages[0].id), "stage_in_use");
    expect(inUse.details?.count).toBe(2);
    await expectConflict(deleteDealStage(w.deps, admin, stages.find((s) => s.kind === "won")!.id), "last_of_kind");
    await expect(deleteDealStage(w.deps, admin, "00000000-0000-4000-8000-00000000dead")).rejects.toBeInstanceOf(NotFoundError);
    const after = await deleteDealStage(w.deps, admin, stages[1].id);
    expect(after.stages.map((s) => [s.name, s.position])).toEqual([["New", 1], ["Proposal", 2], ["Won", 3], ["Lost", 4]]);
    expect(w.state().audits.at(-1)).toMatchObject({ action: "deal_stage.deleted", entityId: stages[1].id });
  });
});
