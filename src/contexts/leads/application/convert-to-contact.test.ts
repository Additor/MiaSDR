import { describe, expect, it } from "vitest";
import type { DbHandle } from "@/platform/db/client";
import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import {
  convertToContact,
  MAX_CONVERT_PREVIEW_IDS,
  personalCampaignSkip,
  previewConvert,
  type ConvertDeps,
  type LiveEnrollmentSummary,
  type Lifecycle,
  type PreviewDeps,
} from "./convert-to-contact";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const NOW = new Date("2026-10-16T09:00:00Z");

interface Row {
  organizationId: string;
  personId: string;
}
interface World {
  people: Map<string, { organizationId: string; lifecycle: Lifecycle; convertedAt: Date | null }>;
  enrollments: Array<Row & { id: string; status: string }>;
  runs: Array<Row & { id: string; status: string; drafts: number; draftsLeft: number }>;
  events: Array<Record<string, unknown>>;
}

type Step = "lockPerson" | "lifecycleOf" | "markConverted" | "stopEnrollments" | "interruptRuns" | "appendEvent";

/** An in-memory stand-in for Postgres: the ports write to `world`, and `transaction` undoes every write when the callback throws. */
function fakeWorld() {
  const world: World = {
    people: new Map([
      ["ada", { organizationId: ORG, lifecycle: "lead", convertedAt: null }],
      ["bob", { organizationId: ORG, lifecycle: "lead", convertedAt: null }],
      ["cy", { organizationId: ORG, lifecycle: "contact", convertedAt: new Date("2026-09-01T00:00:00Z") }],
      ["eve", { organizationId: OTHER_ORG, lifecycle: "lead", convertedAt: null }],
    ]),
    enrollments: [
      { id: "e1", organizationId: ORG, personId: "ada", status: "active" },
      { id: "e2", organizationId: ORG, personId: "ada", status: "pending" },
      { id: "e3", organizationId: ORG, personId: "ada", status: "replied" },
      { id: "e4", organizationId: ORG, personId: "bob", status: "active" },
      { id: "e5", organizationId: OTHER_ORG, personId: "eve", status: "active" },
    ],
    runs: [
      { id: "r1", organizationId: ORG, personId: "ada", status: "active", drafts: 1, draftsLeft: 1 },
      { id: "r2", organizationId: ORG, personId: "bob", status: "active", drafts: 2, draftsLeft: 2 },
    ],
    events: [],
  };
  const calls: Array<{ step: Step; input?: unknown }> = [];
  let failAt: Step | null = null;

  const enter = (step: Step, input?: unknown) => {
    calls.push({ step, input });
    if (failAt === step) throw new Error(`${step} failed`);
  };

  const deps: ConvertDeps = {
    async lockPerson(_tx, organizationId, personId) {
      enter("lockPerson", { organizationId, personId });
    },
    async lifecycleOf(_tx, organizationId, personId) {
      enter("lifecycleOf");
      const person = world.people.get(personId);
      return person && person.organizationId === organizationId ? person.lifecycle : null;
    },
    async markConverted(_tx, organizationId, personId, at) {
      enter("markConverted");
      const person = world.people.get(personId);
      if (!person || person.organizationId !== organizationId || person.lifecycle === "contact") return false;
      person.lifecycle = "contact";
      person.convertedAt = at;
      return true;
    },
    async stopEnrollments(_tx, input) {
      enter("stopEnrollments", input);
      let stopped = 0;
      for (const e of world.enrollments) {
        if (e.organizationId === input.organizationId && e.personId === input.personId && (e.status === "pending" || e.status === "active")) {
          e.status = "cancelled";
          stopped += 1;
        }
      }
      return { stopped };
    },
    async interruptRuns(_tx, input) {
      enter("interruptRuns", input);
      let runs = 0;
      let drafts = 0;
      for (const r of world.runs) {
        if (r.organizationId === input.organizationId && r.personId === input.personId && r.status === "active") {
          r.status = "interrupted";
          runs += 1;
          drafts += r.draftsLeft;
          r.draftsLeft = 0;
        }
      }
      return { runs, drafts };
    },
    async appendEvent(_tx, input) {
      enter("appendEvent", input);
      world.events.push({ ...input });
    },
  };

  const tx = {} as DbHandle;
  async function transaction<T>(fn: (tx: DbHandle) => Promise<T>): Promise<T> {
    const snapshot = structuredClone({ people: [...world.people], enrollments: world.enrollments, runs: world.runs, events: world.events });
    try {
      return await fn(tx);
    } catch (error) {
      world.people = new Map(snapshot.people);
      world.enrollments = snapshot.enrollments;
      world.runs = snapshot.runs;
      world.events = snapshot.events;
      throw error;
    }
  }
  return { world, deps, calls, transaction, failAt: (step: Step | null) => (failAt = step) };
}

const input = (personId: string, organizationId = ORG) => ({ organizationId, personId, reason: "deal_created", actorUserId: "user-1", now: NOW });

describe("convertToContact", () => {
  it("converts the lead, stops its live enrollments and its run, and reports what it stopped", async () => {
    const t = fakeWorld();
    const result = await t.transaction((tx) => convertToContact(t.deps, tx, input("ada")));
    expect(result).toEqual({ changed: true, stopped: { enrollments: 2, runs: 1, drafts: 1 } });
    expect(t.world.people.get("ada")).toEqual({ organizationId: ORG, lifecycle: "contact", convertedAt: NOW });
    expect(t.world.enrollments.map((e) => [e.id, e.status])).toEqual([["e1", "cancelled"], ["e2", "cancelled"], ["e3", "replied"], ["e4", "active"], ["e5", "active"]]);
    expect(t.world.runs.map((r) => [r.id, r.status, r.draftsLeft])).toEqual([["r1", "interrupted", 0], ["r2", "active", 2]]);
  });

  it("writes one lifecycle.converted event with the actor, the reason and the counts", async () => {
    const t = fakeWorld();
    await t.transaction((tx) => convertToContact(t.deps, tx, input("ada")));
    expect(t.world.events).toEqual([
      {
        organizationId: ORG,
        personId: "ada",
        eventType: "lifecycle.converted",
        actorType: "human",
        actorUserId: "user-1",
        meta: { reason: "deal_created", stopped: { enrollments: 2, runs: 1, drafts: 1 } },
      },
    ]);
  });

  it("records a system actor when no user converts", async () => {
    const t = fakeWorld();
    await t.transaction((tx) => convertToContact(t.deps, tx, { ...input("ada"), actorUserId: null }));
    expect(t.world.events[0]).toMatchObject({ actorType: "system", actorUserId: null });
  });

  it("returns changed: false for a contact and touches nothing after the lifecycle read", async () => {
    const t = fakeWorld();
    const result = await t.transaction((tx) => convertToContact(t.deps, tx, input("cy")));
    expect(result).toEqual({ changed: false, stopped: { enrollments: 0, runs: 0, drafts: 0 } });
    expect(t.calls.map((c) => c.step)).toEqual(["lockPerson", "lifecycleOf"]);
    expect(t.world.events).toEqual([]);
    expect(t.world.people.get("cy")?.convertedAt).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  it("changes one row once when it runs twice", async () => {
    const t = fakeWorld();
    const first = await t.transaction((tx) => convertToContact(t.deps, tx, input("ada")));
    const second = await t.transaction((tx) => convertToContact(t.deps, tx, { ...input("ada"), now: new Date("2026-10-17T00:00:00Z") }));
    expect(first.changed).toBe(true);
    expect(second).toEqual({ changed: false, stopped: { enrollments: 0, runs: 0, drafts: 0 } });
    expect(t.world.people.get("ada")?.convertedAt).toEqual(NOW);
    expect(t.world.events).toHaveLength(1);
  });

  it("stops when markConverted reports no change, so a lost race writes no event", async () => {
    const t = fakeWorld();
    t.deps.markConverted = async () => false;
    const result = await t.transaction((tx) => convertToContact(t.deps, tx, input("ada")));
    expect(result.changed).toBe(false);
    expect(t.calls.map((c) => c.step)).toEqual(["lockPerson", "lifecycleOf"]);
    expect(t.world.events).toEqual([]);
  });

  it("runs the guard under the locks after the lifecycle re-read and before any write", async () => {
    const t = fakeWorld();
    const guard = async () => {
      t.calls.push({ step: "guard" as Step });
    };
    await t.transaction((tx) => convertToContact(t.deps, tx, { ...input("ada"), guard }));
    expect(t.calls.map((c) => c.step)).toEqual(["lockPerson", "lifecycleOf", "guard", "markConverted", "stopEnrollments", "interruptRuns", "appendEvent"]);
  });

  it("stops at a throwing guard and writes nothing; a contact never reaches the guard", async () => {
    const t = fakeWorld();
    const refused = new Error("guard refused");
    await expect(t.transaction((tx) => convertToContact(t.deps, tx, { ...input("ada"), guard: async () => Promise.reject(refused) }))).rejects.toBe(refused);
    expect(t.calls.map((c) => c.step)).toEqual(["lockPerson", "lifecycleOf"]);
    expect(t.world.people.get("ada")?.lifecycle).toBe("lead");
    expect(t.world.enrollments.filter((e) => e.personId === "ada").map((e) => e.status)).toEqual(["active", "pending", "replied"]);
    let reached = false;
    await t.transaction((tx) => convertToContact(t.deps, tx, { ...input("cy"), guard: async () => void (reached = true) }));
    expect(reached).toBe(false);
  });

  it("answers NotFound for an unknown person and for another organization's person, and writes nothing", async () => {
    for (const personId of ["nobody", "eve"]) {
      const t = fakeWorld();
      await expect(t.transaction((tx) => convertToContact(t.deps, tx, input(personId)))).rejects.toBeInstanceOf(NotFoundError);
      expect(t.calls.map((c) => c.step)).toEqual(["lockPerson", "lifecycleOf"]);
      expect(t.world.people.get("eve")?.lifecycle).toBe("lead");
    }
  });

  it.each(["markConverted", "stopEnrollments", "interruptRuns", "appendEvent"] as const)("rolls every step back when %s throws", async (step) => {
    const t = fakeWorld();
    const before = structuredClone({ people: [...t.world.people], enrollments: t.world.enrollments, runs: t.world.runs, events: t.world.events });
    t.failAt(step);
    await expect(t.transaction((tx) => convertToContact(t.deps, tx, input("ada")))).rejects.toThrow(`${step} failed`);
    expect({ people: [...t.world.people], enrollments: t.world.enrollments, runs: t.world.runs, events: t.world.events }).toEqual(before);
    // The failing step ran, and nothing after it did.
    expect(t.calls.at(-1)?.step).toBe(step);
  });

  it("passes the organization and the person to every port and stops only that person's rows", async () => {
    const t = fakeWorld();
    await t.transaction((tx) => convertToContact(t.deps, tx, input("ada")));
    const stop = { organizationId: ORG, personId: "ada", reason: "converted", now: NOW };
    expect(t.calls.find((c) => c.step === "lockPerson")?.input).toEqual({ organizationId: ORG, personId: "ada" });
    expect(t.calls.find((c) => c.step === "stopEnrollments")?.input).toEqual(stop);
    expect(t.calls.find((c) => c.step === "interruptRuns")?.input).toEqual(stop);
    // The person's replied enrollment stays; the other person and the other organization keep every row.
    expect(t.world.enrollments.map((e) => `${e.id}:${e.status}`)).toEqual(["e1:cancelled", "e2:cancelled", "e3:replied", "e4:active", "e5:active"]);
    expect(t.world.runs.map((r) => `${r.id}:${r.status}:${r.draftsLeft}`)).toEqual(["r1:interrupted:0", "r2:active:2"]);
    expect(t.world.people.get("bob")?.lifecycle).toBe("lead");
    expect(t.world.people.get("eve")?.lifecycle).toBe("lead");
  });
});

describe("personalCampaignSkip", () => {
  const member = { userId: "u1", role: "member" };
  const personal = (count: number, createdBy: string[]): LiveEnrollmentSummary => ({ regular: 3, personal: { count, createdBy } });

  it("never skips a person without a live personal-campaign enrollment", () => {
    expect(personalCampaignSkip(member, undefined)).toBe(false);
    expect(personalCampaignSkip(member, personal(0, []))).toBe(false);
  });

  it("lets the creator of every personal campaign convert", () => {
    expect(personalCampaignSkip(member, personal(2, ["u1"]))).toBe(false);
  });

  it("skips a member who did not create the personal campaign, also when they created another one", () => {
    expect(personalCampaignSkip(member, personal(1, ["u2"]))).toBe(true);
    expect(personalCampaignSkip(member, personal(2, ["u1", "u2"]))).toBe(true);
    expect(personalCampaignSkip(member, personal(1, []))).toBe(true);
  });

  it("lets an owner or admin convert, also with a combined role", () => {
    for (const role of ["owner", "admin", "member,admin"]) expect(personalCampaignSkip({ userId: "u9", role }, personal(1, ["u2"])), role).toBe(false);
  });
});

describe("previewConvert", () => {
  const actor = (role = "member", userId = "u1"): Actor => ({ userId, organizationId: ORG, role });

  function previewDeps(options: { lifecycles?: Record<string, Lifecycle>; enrollments?: Record<string, LiveEnrollmentSummary>; runs?: Record<string, { runs: number; drafts: number }> }) {
    const asked: Array<{ method: string; organizationId: string; ids: readonly string[] }> = [];
    const deps: PreviewDeps = {
      async lifecycles(organizationId, ids) {
        asked.push({ method: "lifecycles", organizationId, ids });
        return new Map(ids.filter((id) => options.lifecycles?.[id]).map((id) => [id, options.lifecycles![id]]));
      },
      async liveEnrollmentSummary(organizationId, ids) {
        asked.push({ method: "liveEnrollmentSummary", organizationId, ids });
        return new Map(ids.filter((id) => options.enrollments?.[id]).map((id) => [id, options.enrollments![id]]));
      },
      async previewRunStop(organizationId, ids) {
        asked.push({ method: "previewRunStop", organizationId, ids });
        return new Map(ids.filter((id) => options.runs?.[id]).map((id) => [id, options.runs![id]]));
      },
    };
    return { deps, asked };
  }

  it("sums enrollments, runs and the follow-up drafts that conversion retires", async () => {
    const { deps } = previewDeps({
      lifecycles: { a: "lead", b: "lead", c: "contact" },
      enrollments: { a: { regular: 2, personal: { count: 0, createdBy: [] } }, b: { regular: 1, personal: { count: 0, createdBy: [] } } },
      runs: { a: { runs: 1, drafts: 2 } },
    });
    expect(await previewConvert(deps, actor(), ["a", "b", "c", "missing"])).toEqual({
      people: 2,
      alreadyContacts: 1,
      enrollments: 3,
      runs: 1,
      followUpDraftsToRetire: 2,
      skippedPersonalCampaign: 0,
    });
  });

  it("reports zero effects for a person with no enrollment and no run", async () => {
    const { deps } = previewDeps({ lifecycles: { a: "lead" } });
    expect(await previewConvert(deps, actor(), ["a"])).toMatchObject({ people: 1, enrollments: 0, runs: 0, followUpDraftsToRetire: 0 });
  });

  it("counts a personal-campaign enrollment for its creator and for an admin, and skips the person for another member", async () => {
    const lifecycles = { a: "lead", b: "lead" } as const;
    const enrollments = {
      a: { regular: 1, personal: { count: 1, createdBy: ["u1"] } },
      b: { regular: 1, personal: { count: 2, createdBy: ["u2"] } },
    };
    const runs = { a: { runs: 1, drafts: 1 }, b: { runs: 5, drafts: 5 } };

    const asCreator = await previewConvert(previewDeps({ lifecycles, enrollments, runs }).deps, actor("member", "u1"), ["a", "b"]);
    expect(asCreator).toMatchObject({ people: 1, enrollments: 2, runs: 1, followUpDraftsToRetire: 1, skippedPersonalCampaign: 1 });

    const asAdmin = await previewConvert(previewDeps({ lifecycles, enrollments, runs }).deps, actor("admin", "u9"), ["a", "b"]);
    expect(asAdmin).toMatchObject({ people: 2, enrollments: 5, runs: 6, followUpDraftsToRetire: 6, skippedPersonalCampaign: 0 });
  });

  it("asks the ports for the actor's organization only, and never asks about contacts or skipped people", async () => {
    const { deps, asked } = previewDeps({
      lifecycles: { a: "lead", b: "lead", c: "contact" },
      enrollments: { b: { regular: 0, personal: { count: 1, createdBy: ["u2"] } } },
    });
    await previewConvert(deps, actor(), ["a", "b", "c"]);
    expect(asked.every((call) => call.organizationId === ORG)).toBe(true);
    expect(asked.find((call) => call.method === "liveEnrollmentSummary")?.ids).toEqual(["a", "b"]);
    expect(asked.find((call) => call.method === "previewRunStop")?.ids).toEqual(["a"]);
  });

  it("answers an empty preview for no ids, deduplicates, and refuses more than 500", async () => {
    const { deps, asked } = previewDeps({ lifecycles: { a: "lead" } });
    expect(await previewConvert(deps, actor(), [])).toMatchObject({ people: 0, alreadyContacts: 0 });
    expect(asked).toEqual([]);
    expect((await previewConvert(deps, actor(), ["a", "a", "a"])).people).toBe(1);
    const many = Array.from({ length: MAX_CONVERT_PREVIEW_IDS + 1 }, (_, i) => `p${i}`);
    await expect(previewConvert(deps, actor(), many)).rejects.toBeInstanceOf(ValidationError);
    await expect(previewConvert(deps, actor(), many.slice(0, MAX_CONVERT_PREVIEW_IDS))).resolves.toMatchObject({ people: 0 });
  });
});
