import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockRetryStats, setLockTimeout } from "@/platform/db/person-locks";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/shared/errors";
import { bootDealsKit, holdLocks, type DealsKit, type DealsOrg } from "../../../../test-support/deals-test-kit";
import { describeDb, TEST_DATABASE_URL } from "@/test-support/db";

/**
 * The deals context against Postgres ("Leads and CRM" in docs/decisions.md): conversion plus deal in one
 * transaction, idempotency, rollback per step, the preview, stage moves and settings, validation, attribution, the
 * personal-campaign rule, organization scope and bulk creation. The lock races are in conversion-races.integration.test.ts.
 * Needs TEST_DATABASE_URL pointing at a migrated Postgres.
 */
describeDb("deals context", () => {
  let kit: DealsKit;
  let deals: typeof import("../../application/deals");
  let stagesApp: typeof import("../../application/deal-stages");
  let composition: typeof import("../deals-composition");
  let leadsApp: typeof import("@/contexts/leads/application/convert-to-contact");
  let store: typeof import("../drizzle-deal-store").drizzleDealStore;
  let appDb: typeof import("@/platform/db/client").db;

  beforeAll(async () => {
    kit = await bootDealsKit(TEST_DATABASE_URL ?? "");
    deals = await import("../../application/deals");
    stagesApp = await import("../../application/deal-stages");
    composition = await import("../deals-composition");
    leadsApp = await import("@/contexts/leads/application/convert-to-contact");
    store = (await import("../drizzle-deal-store")).drizzleDealStore;
    appDb = (await import("@/platform/db/client")).db;
  }, 60_000);

  afterAll(async () => {
    await kit?.cleanup();
  });

  const deps = () => composition.dealsDeps();
  const failure = async (run: Promise<unknown>) => run.then(() => null, (error: unknown) => error);
  const conflictCode = async (run: Promise<unknown>) => ((await failure(run)) as ConflictError | null)?.details?.code;

  /** A lead who replied to a regular campaign, with an active follow-up run, its reply draft, and a live enrollment elsewhere. */
  async function repliedLeadWithRun(f: DealsOrg) {
    const lead = await f.ingest();
    const { campaignId, repliedEnrollmentId } = await f.emailedBy(lead.personId);
    await f.cycle();
    const other = await f.campaign({ name: "Second campaign" });
    const live = await f.enrollment(other, lead.personId, "active");
    const pending = await f.enrollment(await f.campaign(), lead.personId, "pending");
    return { ...lead, campaignId, repliedEnrollmentId, live, pending };
  }

  /** Rows the conversion can change, for the person. */
  async function snapshot(f: DealsOrg, personId: string) {
    const person = await kit.one("select lifecycle, converted_at from people where id = $1", [personId]);
    const enrollments = await kit.sql`select id, status, stop_reason from campaign_enrollments where person_id = ${personId} order by id`;
    const runs = await kit.sql`select r.id, r.status from sequence_runs r join records rec on rec.id = r.record_id where rec.person_id = ${personId} order by r.id`;
    const drafts = await kit.sql`select d.id, d.status from drafts d join records rec on rec.id = d.record_id where rec.person_id = ${personId} order by d.id`;
    const events = await kit.count("events", f.org, `person_id = '${personId}' and (event_type like 'deal.%' or event_type = 'lifecycle.converted')`);
    const dealRows = await kit.count("deals", f.org, `person_id = '${personId}'`);
    return { person, enrollments: [...enrollments], runs: [...runs], drafts: [...drafts], events, deals: dealRows };
  }

  describe("conversion and deal in one transaction; the effects equal the rows changed", () => {
    it("previews, converts, stops and creates, and reports exactly what changed", async () => {
      const f = await kit.organization();
      const lead = await repliedLeadWithRun(f);
      const before = await snapshot(f, lead.personId);
      expect(before.runs.map((r) => r.status)).toEqual(["active"]);
      const retirable = before.drafts.filter((d) => ["generating", "awaiting_review", "failed"].includes(d.status as string)).length;
      expect(retirable).toBeGreaterThan(0);

      const preview = await leadsApp.previewConvert(composition.convertPreviewDeps(), f.owner, [lead.personId]);
      expect(preview).toEqual({ people: 1, alreadyContacts: 0, enrollments: 2, runs: 1, followUpDraftsToRetire: retirable, skippedPersonalCampaign: 0 });

      const result = await deals.createDealFromLead(deps(), f.owner, lead.personId, { amount: "1200", currency: "EUR" });
      expect(result.stopped).toEqual({ enrollments: preview.enrollments, runs: preview.runs, drafts: preview.followUpDraftsToRetire });
      const after = await snapshot(f, lead.personId);
      expect(after.person.lifecycle).toBe("contact");
      expect(after.enrollments.filter((e) => e.status === "cancelled" && e.stop_reason === "converted").map((e) => e.id).sort()).toEqual([lead.live, lead.pending].sort());
      expect(after.enrollments.find((e) => e.id === lead.repliedEnrollmentId)?.status).toBe("replied");
      expect(after.runs.map((r) => r.status)).toEqual(["interrupted"]);
      expect(await kit.count("drafts", f.org, `record_id = '${lead.recordId}' and status = 'stale' and error = 'The follow-up sequence ended.'`)).toBe(result.stopped.drafts);

      const deal = await kit.one("select * from deals where id = $1", [result.dealId]);
      expect(deal).toMatchObject({ person_id: lead.personId, stage_kind: "open", owner_user_id: f.owner.userId, currency: "EUR", source_enrollment_id: lead.repliedEnrollmentId, version: 0, closed_at: null });
      expect(Number(deal.amount_minor)).toBe(120000);
      expect(new Date(deal.stage_changed_at).getTime()).toBe(new Date(deal.created_at).getTime());
      const events = await kit.sql`select event_type, actor_type, actor_user_id, record_id, meta from events where person_id = ${lead.personId} and (event_type like 'deal.%' or event_type = 'lifecycle.converted') order by created_at, event_type`;
      expect(events.map((e) => e.event_type).sort()).toEqual(["deal.created", "lifecycle.converted"]);
      expect(events.every((e) => e.actor_type === "human" && e.actor_user_id === f.owner.userId && e.record_id === null)).toBe(true);
      expect(events.find((e) => e.event_type === "deal.created")?.meta).toMatchObject({ dealId: result.dealId, stopped: result.stopped });

      // The stage list was created by the first write; the deal sits in the first open stage.
      const stage = await kit.one("select name, position from deal_stages where id = $1", [deal.stage_id]);
      expect(stage).toEqual({ name: "New", position: 1 });
    }, 60_000);

    it("a person with no run previews and stops zero follow-ups", async () => {
      const f = await kit.organization();
      const personId = await f.person();
      const preview = await leadsApp.previewConvert(composition.convertPreviewDeps(), f.owner, [personId]);
      expect(preview).toMatchObject({ people: 1, runs: 0, followUpDraftsToRetire: 0, enrollments: 0 });
      expect((await deals.createDealFromLead(deps(), f.owner, personId)).stopped).toEqual({ enrollments: 0, runs: 0, drafts: 0 });
    });
  });

  describe("idempotency and concurrent calls", () => {
    it("replays the first result for the same key; without a key a second call is already_converted with the deal id", async () => {
      const f = await kit.organization();
      const personId = await f.person();
      const first = await deals.createDealFromLead(deps(), f.owner, personId, { idempotencyKey: "dialog-a" });
      expect(first.replayed).toBe(false);
      expect(await deals.createDealFromLead(deps(), f.owner, personId, { idempotencyKey: "dialog-a" })).toEqual({ ...first, replayed: true });
      const conflict = (await failure(deals.createDealFromLead(deps(), f.owner, personId))) as ConflictError;
      expect(conflict.details).toEqual({ code: "already_converted", dealId: first.dealId });
      expect(await kit.count("deals", f.org)).toBe(1);
      // A contact with no deal (deleted) answers already_converted with null.
      await deals.deleteDeal(deps(), f.owner, first.dealId);
      expect(((await failure(deals.createDealFromLead(deps(), f.owner, personId))) as ConflictError).details).toEqual({ code: "already_converted", dealId: null });
    });

    it("concurrent calls produce one deal, with or without a shared key", async () => {
      const f = await kit.organization();
      const a = await f.person();
      const outcomes = await Promise.all(Array.from({ length: 6 }, () => failure(deals.createDealFromLead(deps(), f.owner, a)).then((e) => e ?? "ok")));
      expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
      expect(outcomes.filter((o) => o instanceof ConflictError && o.details?.code === "already_converted")).toHaveLength(5);
      const b = await f.person();
      const keyed = await Promise.all(Array.from({ length: 6 }, () => deals.createDealFromLead(deps(), f.owner, b, { idempotencyKey: "same-key" })));
      expect(new Set(keyed.map((r) => r.dealId)).size).toBe(1);
      expect(keyed.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await kit.count("deals", f.org)).toBe(2);
      expect(await kit.count("events", f.org, "event_type = 'lifecycle.converted'")).toBe(2);
    });
  });

  describe("a failure in any step rolls back all steps", () => {
    const steps = ["lockPerson", "stopEnrollments", "interruptRuns", "appendEvent", "latestRepliedEnrollment", "insert", "dealEvent"] as const;
    for (const step of steps) {
      it(`a failing ${step} leaves the lead, its enrollments, run, drafts and events as they were`, async () => {
        const f = await kit.organization();
        const lead = await repliedLeadWithRun(f);
        const before = await snapshot(f, lead.personId);
        const boom = async () => {
          throw new Error(`${step} failed`);
        };
        const conversion = { ...composition.conversionDeps };
        if (step === "lockPerson" || step === "stopEnrollments" || step === "interruptRuns" || step === "appendEvent") {
          const original = conversion[step] as (...args: unknown[]) => Promise<unknown>;
          // The failing port runs its real write first, so the rollback has something to undo.
          (conversion as Record<string, unknown>)[step] = async (...args: unknown[]) => {
            await original(...args);
            return boom();
          };
        }
        const overrides = composition.dealsDeps({
          convertLead: (tx, input) => leadsApp.convertToContact(conversion, tx, input),
          outreach: step === "latestRepliedEnrollment" ? { ...composition.dealsDeps().outreach, latestRepliedEnrollment: boom } : composition.dealsDeps().outreach,
          store: step === "insert" ? { ...store, insert: async (tx, deal) => (await store.insert(tx, deal), boom()) } : store,
          events: step === "dealEvent" ? { append: boom } : composition.dealsDeps().events,
        });
        await expect(deals.createDealFromLead(overrides, f.owner, lead.personId)).rejects.toThrow(`${step} failed`);
        expect(await snapshot(f, lead.personId)).toEqual(before);
      }, 60_000);
    }
  });

  describe("stage moves", () => {
    let f: DealsOrg;
    let by: (name: string) => string;
    beforeAll(async () => {
      f = await kit.organization();
      await deals.createDealFromLead(deps(), f.owner, await f.person());
      const stages = await store.listStages(f.org);
      by = (name: string) => stages.find((s) => s.name === name)!.id;
    });
    const freshDeal = async () => (await deals.createDealFromLead(deps(), f.owner, await f.person())).dealId;
    const row = (dealId: string) => kit.one("select stage_id, stage_kind, closed_at, lost_reason, stage_changed_at, version from deals where id = $1", [dealId]);

    it("refuses a stale version, a move to Lost without a reason and an unknown stage, and leaves the deal as it was", async () => {
      const dealId = await freshDeal();
      const created = await row(dealId);
      expect(await conflictCode(deals.moveDealStage(deps(), f.owner, dealId, { stageId: by("Meeting"), expectedVersion: 1 }))).toBe("stale_version");
      expect(await failure(deals.moveDealStage(deps(), f.owner, dealId, { stageId: by("Lost"), expectedVersion: 0 }))).toBeInstanceOf(ValidationError);
      expect(await failure(deals.moveDealStage(deps(), f.owner, dealId, { stageId: "00000000-0000-4000-8000-000000000001", expectedVersion: 0 }))).toBeInstanceOf(ValidationError);
      expect(await row(dealId)).toEqual(created);
    });

    it("closes a deal moved to Lost with its reason and moves stage_changed_at", async () => {
      const dealId = await freshDeal();
      const created = await row(dealId);
      const lost = await deals.moveDealStage(deps(), f.owner, dealId, { stageId: by("Lost"), expectedVersion: 0, lostReason: "Went with a competitor" });
      expect(lost).toMatchObject({ version: 1, lostReason: "Went with a competitor", stage: { name: "Lost", kind: "lost" } });
      expect(lost.closedAt).toBeInstanceOf(Date);
      expect(lost.stageChangedAt.getTime()).toBeGreaterThan(new Date(created.stage_changed_at).getTime());
    });

    it("clears the lost reason on a move out of Lost, and ignores a reason sent for another stage", async () => {
      const dealId = await freshDeal();
      await deals.moveDealStage(deps(), f.owner, dealId, { stageId: by("Lost"), expectedVersion: 0, lostReason: "Budget" });
      const won = await deals.moveDealStage(deps(), f.owner, dealId, { stageId: by("Won"), expectedVersion: 1, lostReason: "ignored" });
      expect(won).toMatchObject({ lostReason: null, stage: { kind: "won" } });
      expect(won.closedAt).toBeInstanceOf(Date);
    });

    it("clears closed_at on a move back to an open stage", async () => {
      const dealId = await freshDeal();
      await deals.moveDealStage(deps(), f.owner, dealId, { stageId: by("Won"), expectedVersion: 0 });
      const reopened = await deals.moveDealStage(deps(), f.owner, dealId, { stageId: by("Proposal"), expectedVersion: 1 });
      expect(reopened).toMatchObject({ closedAt: null, lostReason: null, version: 2, stage: { name: "Proposal", kind: "open" } });
    });

    it("keeps stage_changed_at on an edit that does not move the deal", async () => {
      const dealId = await freshDeal();
      await deals.moveDealStage(deps(), f.owner, dealId, { stageId: by("Meeting"), expectedVersion: 0 });
      const moved = (await row(dealId)).stage_changed_at;
      const edited = await deals.updateDeal(deps(), f.owner, dealId, { expectedVersion: 1, title: "Renamed", expectedCloseOn: "2027-01-31" });
      expect(edited).toMatchObject({ version: 2, title: "Renamed", expectedCloseOn: "2027-01-31" });
      expect((await row(dealId)).stage_changed_at).toEqual(moved);
    });

    it("appends one event per move and per edit", async () => {
      const personId = await f.person();
      const { dealId } = await deals.createDealFromLead(deps(), f.owner, personId);
      await deals.moveDealStage(deps(), f.owner, dealId, { stageId: by("Lost"), expectedVersion: 0, lostReason: "Timing" });
      await deals.moveDealStage(deps(), f.owner, dealId, { stageId: by("Won"), expectedVersion: 1 });
      await deals.moveDealStage(deps(), f.owner, dealId, { stageId: by("Proposal"), expectedVersion: 2 });
      await deals.updateDeal(deps(), f.owner, dealId, { expectedVersion: 3, title: "Renamed" });
      const kinds = await kit.sql`select event_type from events where person_id = ${personId} and event_type like 'deal.%' order by created_at`;
      expect(kinds.map((k) => k.event_type)).toEqual(["deal.created", "deal.stage_moved", "deal.stage_moved", "deal.stage_moved", "deal.updated"]);
    });

    it("deletes only an open deal, and the person stays a contact", async () => {
      const f = await kit.organization();
      const personId = await f.person();
      const { dealId } = await deals.createDealFromLead(deps(), f.owner, personId);
      const won = (await store.listStages(f.org)).find((s) => s.kind === "won")!;
      await deals.moveDealStage(deps(), f.owner, dealId, { stageId: won.id, expectedVersion: 0 });
      expect(await conflictCode(deals.deleteDeal(deps(), f.owner, dealId))).toBe("deal_closed");
      const open = (await store.listStages(f.org)).find((s) => s.kind === "open")!;
      await deals.moveDealStage(deps(), f.owner, dealId, { stageId: open.id, expectedVersion: 1 });
      expect(await conflictCode(deals.deleteDeal(deps(), f.owner, dealId, { expectedVersion: 0 }))).toBe("stale_version");
      await deals.deleteDeal(deps(), f.owner, dealId, { expectedVersion: 2 });
      expect(await kit.count("deals", f.org)).toBe(0);
      expect((await kit.one("select lifecycle from people where id = $1", [personId])).lifecycle).toBe("contact");
    });
  });

  describe("stage settings", () => {
    /** An organization with its stages written, plus an open stage Demo that the member added. */
    async function withDemo() {
      const f = await kit.organization();
      const created = await stagesApp.createDealStage(deps(), f.member, { name: "Demo", kind: "open" });
      const id = (name: string) => created.stages.find((s) => s.name === name)!.id as string;
      return { f, created, id };
    }

    it("lists the default stages of an organization without writing them", async () => {
      const f = await kit.organization();
      expect((await stagesApp.listDealStages(deps(), f.owner)).virtual).toBe(true);
      expect(await kit.count("deal_stages", f.org)).toBe(0);
    });

    it("adds an open stage after the open ones and refuses a name already taken", async () => {
      const { f, created } = await withDemo();
      expect(created.stages.map((s) => [s.name, s.kind, s.position])).toEqual([
        ["New", "open", 1], ["Meeting", "open", 2], ["Proposal", "open", 3], ["Demo", "open", 4], ["Won", "won", 5], ["Lost", "lost", 6],
      ]);
      expect(await conflictCode(stagesApp.createDealStage(deps(), f.owner, { name: "demo", kind: "open" }))).toBe("name_taken");
    });

    it("refuses to delete a stage with deals, with their count, and the last stage of a kind", async () => {
      const { f, id } = await withDemo();
      await deals.createDealFromLead(deps(), f.owner, await f.person(), { stageId: id("Meeting") });
      await deals.createDealFromLead(deps(), f.owner, await f.person(), { stageId: id("Meeting") });
      const inUse = (await failure(stagesApp.deleteDealStage(deps(), f.owner, id("Meeting")))) as ConflictError;
      expect(inUse.details).toEqual({ code: "stage_in_use", count: 2 });
      expect(await conflictCode(stagesApp.deleteDealStage(deps(), f.owner, id("Won")))).toBe("last_of_kind");
      expect(await conflictCode(stagesApp.deleteDealStage(deps(), f.owner, id("Lost")))).toBe("last_of_kind");
    });

    it("swaps positions in one transaction and refuses a closed stage before an open one", async () => {
      const { f, id } = await withDemo();
      await deals.createDealFromLead(deps(), f.owner, await f.person(), { stageId: id("Meeting") });
      // A swap of positions inside one transaction passes the deferred key.
      const swapped = await stagesApp.reorderDealStages(deps(), f.owner, [id("Demo"), id("New"), id("Meeting"), id("Proposal"), id("Won"), id("Lost")]);
      expect(swapped.stages.map((s) => s.name)).toEqual(["Demo", "New", "Meeting", "Proposal", "Won", "Lost"]);
      expect(swapped.stages.find((s) => s.name === "Meeting")?.dealCount).toBe(1);
      await expect(stagesApp.reorderDealStages(deps(), f.owner, [id("Won"), id("Demo"), id("New"), id("Meeting"), id("Proposal"), id("Lost")])).rejects.toThrow("Open stages come first");
    });

    it("renames a stage, and deletes an empty one closing the gap in positions", async () => {
      const { f, id } = await withDemo();
      await stagesApp.renameDealStage(deps(), f.owner, id("Demo"), { name: "Discovery" });
      const afterDelete = await stagesApp.deleteDealStage(deps(), f.owner, id("Proposal"));
      expect(afterDelete.stages.map((s) => [s.name, s.position])).toEqual([["New", 1], ["Meeting", 2], ["Discovery", 3], ["Won", 4], ["Lost", 5]]);
    });

    it("audits each stage change with its actor", async () => {
      const { f, id } = await withDemo();
      await stagesApp.reorderDealStages(deps(), f.owner, [id("Demo"), id("New"), id("Meeting"), id("Proposal"), id("Won"), id("Lost")]);
      await stagesApp.renameDealStage(deps(), f.owner, id("Demo"), { name: "Discovery" });
      await stagesApp.deleteDealStage(deps(), f.owner, id("Proposal"));
      const audits = await kit.sql`select action, actor_user_id from audit_log where organization_id = ${f.org} order by created_at, action`;
      expect(audits.map((a) => [a.action, a.actor_user_id])).toEqual([
        ["deal_stage.created", f.member.userId],
        ["deal_stage.reordered", f.owner.userId],
        ["deal_stage.renamed", f.owner.userId],
        ["deal_stage.deleted", f.owner.userId],
      ]);
    });

    it("answers stage_in_use when a deal lands in the stage after the count, and keeps the stage", async () => {
      const f = await kit.organization();
      const created = await stagesApp.createDealStage(deps(), f.owner, { name: "Demo", kind: "open" });
      const demo = created.stages.find((s) => s.name === "Demo")!.id as string;
      const lead = await f.person();
      // The deal commits on its own connection right after the delete counted zero deals, under the pipeline lock it does not take.
      const racing = composition.dealsDeps({
        store: {
          ...store,
          stageDealCounts: async (organizationId, handle) => {
            const counts = await store.stageDealCounts(organizationId, handle);
            if (handle) await deals.createDealFromLead(deps(), f.owner, lead, { stageId: demo });
            return counts;
          },
        },
      });
      const error = (await failure(stagesApp.deleteDealStage(racing, f.owner, demo))) as ConflictError;
      expect(error).toBeInstanceOf(ConflictError);
      expect(error.details).toEqual({ code: "stage_in_use", count: 1 });
      expect(await kit.count("deal_stages", f.org, `id = '${demo}'`)).toBe(1);
      expect(await kit.count("audit_log", f.org, "action = 'deal_stage.deleted'")).toBe(0);
    });

    it("ensuring stages takes the pipeline lock only for an organization without stages, and concurrent first writes seed once", async () => {
      const f = await kit.organization();
      const advisoryLocks = async () => Number((await kit.sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and pid in (select pid from pg_stat_activity where datname = current_database())`)[0].n);
      const lockedWhileEnsuring = async () =>
        appDb.transaction(async (tx) => {
          const stages = await store.ensureStages(tx, f.org);
          return { stages: stages.length, held: await advisoryLocks() };
        });
      expect(await lockedWhileEnsuring()).toEqual({ stages: 5, held: 1 });
      expect(await lockedWhileEnsuring()).toEqual({ stages: 5, held: 0 });

      const g = await kit.organization();
      await Promise.all(Array.from({ length: 5 }, () => appDb.transaction((tx) => store.ensureStages(tx, g.org))));
      expect(await kit.count("deal_stages", g.org)).toBe(5);
    });
  });

  describe("validation against Postgres", () => {
    // The rest of the input rules are unit tests in application/deals.test.ts.
    it("refuses an owner who is a member of another organization", async () => {
      const f = await kit.organization();
      const other = await kit.organization();
      const personId = await f.person();
      expect(await failure(deals.createDealFromLead(deps(), f.owner, personId, { ownerId: other.owner.userId }))).toBeInstanceOf(ValidationError);
      expect((await kit.one("select lifecycle from people where id = $1", [personId])).lifecycle).toBe("lead");
    });

    it("makes one deal for a contact from concurrent calls with the same key", async () => {
      const f = await kit.organization();
      const contact = await f.person({ contact: true });
      const results = await Promise.all(Array.from({ length: 4 }, () => deals.createDealForContact(deps(), f.member, contact, { idempotencyKey: "k-contact", amount: "5000", currency: "KRW" })));
      expect(new Set(results.map((r) => r.dealId)).size).toBe(1);
      const row = await kit.one("select amount_minor, currency, owner_user_id, source_enrollment_id from deals where person_id = $1", [contact]);
      expect(row).toMatchObject({ currency: "KRW", owner_user_id: f.member.userId, source_enrollment_id: null });
      expect(Number(row.amount_minor)).toBe(5000);
    });
  });

  describe("source enrollment", () => {
    it("takes the latest replied enrollment by updated_at, then id; null without one; From is hidden for a personal campaign", async () => {
      const f = await kit.organization();
      const personId = await f.person();
      const older = await f.enrollment(await f.campaign({ name: "Older" }), personId, "replied");
      const newer = await f.enrollment(await f.campaign({ name: "Newer" }), personId, "replied");
      await f.enrollment(await f.campaign({ name: "Removed" }), personId, "removed");
      await kit.sql`update campaign_enrollments set updated_at = now() - interval '1 day' where id = ${older}`;
      await kit.sql`update campaign_enrollments set updated_at = now() where id = ${newer}`;
      const { dealId } = await deals.createDealFromLead(deps(), f.owner, personId);
      const deal = await deals.getDeal(deps(), f.owner, dealId);
      expect(deal.source).toMatchObject({ enrollmentId: newer, campaignName: "Newer" });

      const tieA = await f.person();
      const e1 = await f.enrollment(await f.campaign(), tieA, "replied");
      const e2 = await f.enrollment(await f.campaign(), tieA, "replied");
      await kit.sql`update campaign_enrollments set updated_at = '2026-10-01T00:00:00Z' where id in (${e1}, ${e2})`;
      const tie = await deals.createDealFromLead(deps(), f.owner, tieA);
      expect((await kit.one("select source_enrollment_id from deals where id = $1", [tie.dealId])).source_enrollment_id).toBe([e1, e2].sort().at(-1));

      const none = await deals.createDealFromLead(deps(), f.owner, await f.person());
      expect((await deals.getDeal(deps(), f.owner, none.dealId)).source).toBeNull();

      const personal = await f.person();
      const privateCampaign = await f.campaign({ type: "personal", createdBy: f.owner.userId, name: "Private" });
      await f.enrollment(privateCampaign, personal, "replied", "linkedin");
      const hidden = await deals.createDealFromLead(deps(), f.owner, personal);
      expect((await kit.one("select source_enrollment_id from deals where id = $1", [hidden.dealId])).source_enrollment_id).not.toBeNull();
      expect((await deals.getDeal(deps(), f.owner, hidden.dealId)).source).toBeNull();
      const card = (await deals.board(deps(), f.owner)).columns.flatMap((c) => c.cards).find((c) => c.id === hidden.dealId);
      expect(card?.source).toBeNull();
      expect(JSON.stringify(await deals.board(deps(), f.owner))).not.toContain("Private");
    });
  });

  describe("personal campaigns", () => {
    it("skips a member who did not create the campaign and converts for the creator or an admin", async () => {
      const f = await kit.organization();
      const privateCampaign = await f.campaign({ type: "personal", createdBy: f.creator.userId });
      const a = await f.person();
      const b = await f.person();
      await f.enrollment(privateCampaign, a, "active", "linkedin");
      await f.enrollment(privateCampaign, b, "pending", "linkedin");
      const before = await snapshot(f, a);
      expect(await failure(deals.createDealFromLead(deps(), f.member, a))).toBeInstanceOf(ForbiddenError);
      expect(await snapshot(f, a)).toEqual(before);
      expect(await deals.createDealsFromLeads(deps(), f.member, [a])).toEqual({ created: [], skipped: [{ personId: a, reason: "personal_campaign" }] });
      expect((await leadsApp.previewConvert(composition.convertPreviewDeps(), f.member, [a, b])).skippedPersonalCampaign).toBe(2);

      expect((await deals.createDealFromLead(deps(), f.creator, a)).stopped.enrollments).toBe(1);
      expect((await deals.createDealFromLead(deps(), f.owner, b)).stopped.enrollments).toBe(1);
      expect(await kit.count("campaign_enrollments", f.org, "status = 'cancelled' and stop_reason = 'converted'")).toBe(2);
    });
  });

  describe("the personal-campaign rule holds under the person's locks", () => {
    it("catches an enrollment that commits between the early read and the locks, for one deal and in bulk", async () => {
      const f = await kit.organization();
      const privateCampaign = await f.campaign({ type: "personal", createdBy: f.creator.userId });
      const outreach = deps().outreach;
      /** Deps whose first live-enrollment read is followed by a committed enrollment of the person in the private campaign. */
      const racing = (personId: string) => {
        let reads = 0;
        return composition.dealsDeps({
          outreach: {
            ...outreach,
            liveEnrollmentSummary: async (organizationId, ids, tx) => {
              const summary = await outreach.liveEnrollmentSummary(organizationId, ids, tx);
              reads += 1;
              if (reads === 1) await f.enrollment(privateCampaign, personId, "active", "linkedin");
              return summary;
            },
          },
        });
      };
      const one = await f.person();
      expect(await failure(deals.createDealFromLead(racing(one), f.member, one))).toBeInstanceOf(deals.PersonalCampaignError);
      expect((await kit.one("select lifecycle from people where id = $1", [one])).lifecycle).toBe("lead");
      expect(await kit.count("deals", f.org, `person_id = '${one}'`)).toBe(0);
      expect(await kit.count("campaign_enrollments", f.org, `person_id = '${one}' and status = 'active'`)).toBe(1);

      const bulk = await f.person();
      expect(await deals.createDealsFromLeads(racing(bulk), f.member, [bulk])).toEqual({ created: [], skipped: [{ personId: bulk, reason: "personal_campaign" }] });
      expect((await kit.one("select lifecycle from people where id = $1", [bulk])).lifecycle).toBe("lead");
    });
  });

  describe("organization scope", () => {
    it("answers 404 for another organization's ids in every use case", async () => {
      const f = await kit.organization();
      const g = await kit.organization();
      const lead = await g.person();
      const contact = await g.person({ contact: true });
      const companyId = await g.company("Theirs");
      const { dealId } = await deals.createDealFromLead(deps(), g.owner, await g.person());
      const stage = (await store.listStages(g.org))[0].id;
      const notFound = async (run: Promise<unknown>) => expect(await failure(run)).toBeInstanceOf(NotFoundError);
      await notFound(deals.createDealFromLead(deps(), f.owner, lead));
      await notFound(deals.createDealForContact(deps(), f.owner, contact, { idempotencyKey: "k" }));
      await notFound(deals.getDeal(deps(), f.owner, dealId));
      await notFound(deals.moveDealStage(deps(), f.owner, dealId, { stageId: stage, expectedVersion: 0 }));
      await notFound(deals.updateDeal(deps(), f.owner, dealId, { expectedVersion: 0, title: "x" }));
      await notFound(deals.deleteDeal(deps(), f.owner, dealId));
      await notFound(stagesApp.renameDealStage(deps(), f.owner, stage, { name: "Mine" }));
      await notFound(stagesApp.deleteDealStage(deps(), f.owner, stage));
      await notFound(deals.getCompany(deps(), f.owner, companyId));
      expect(await deals.createDealsFromLeads(deps(), f.owner, [lead])).toEqual({ created: [], skipped: [{ personId: lead, reason: "not_found" }] });
      expect(await leadsApp.previewConvert(composition.convertPreviewDeps(), f.owner, [lead])).toMatchObject({ people: 0, alreadyContacts: 0 });
      expect((await deals.dealSummaryForPeople(deps(), f.owner, [contact])).get(contact)).toEqual({ deals: [], openDeals: 0, latestDealId: null });
      expect((await kit.one("select lifecycle from people where id = $1", [lead])).lifecycle).toBe("lead");
      expect((await kit.one("select version, title from deals where id = $1", [dealId])).version).toBe(0);
    });
  });

  describe("bulk creation", () => {
    it("reports created and skipped per person; a held lock times out, retries once and reports retryable while the others commit", async () => {
      const f = await kit.organization();
      const a = await f.person({ name: "Ada" });
      const contact = await f.person({ contact: true });
      const held = await f.ingest();
      const b = await f.person({ name: "Bob" });
      const before = lockRetryStats.retries;
      // A 200 ms lock timeout stands in for the 5 s one, so the held record times out twice without a 10 s wait.
      const quick = composition.dealsDeps({
        uow: {
          run: (fn, options) =>
            appDb.transaction(async (tx) => {
              if (options?.lockTimeout) await setLockTimeout(tx, "200ms");
              return fn(tx);
            }),
        },
      });
      // Another transaction holds the record of `held` for both attempts.
      const gate = await holdLocks(TEST_DATABASE_URL ?? "", (tx) => tx`select id from records where id = ${held.recordId} for update`);
      const result = await deals.createDealsFromLeads(quick, f.member, [a, contact, held.personId, "00000000-0000-4000-8000-000000000001", b]).finally(() => gate.release());
      expect(result.created.map((c) => c.personId)).toEqual([a, b]);
      expect(result.skipped).toEqual([
        { personId: contact, reason: "already_converted" },
        { personId: held.personId, reason: "retryable" },
        { personId: "00000000-0000-4000-8000-000000000001", reason: "not_found" },
      ]);
      expect(lockRetryStats.retries).toBe(before + 1);
      expect((await kit.one("select lifecycle from people where id = $1", [held.personId])).lifecycle).toBe("lead");
      const titles = await kit.sql`select title from deals where organization_id = ${f.org} order by title`;
      expect(titles.map((t) => t.title)).toEqual(["Ada", "Bob"]);
      // After the lock is gone the person converts.
      expect((await deals.createDealsFromLeads(deps(), f.member, [held.personId])).created).toHaveLength(1);
    });

    it("takes 200 ids at most", async () => {
      const f = await kit.organization();
      expect(await failure(deals.createDealsFromLeads(deps(), f.owner, Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)))).toBeInstanceOf(ValidationError);
    });
  });
});
