import { violatedConstraint } from "@/platform/db/errors";
import { parseCreationKey, type AddContactInput } from "@/contexts/people/application/add-contact";
import { personalCampaignSkip } from "@/contexts/people/application/convert-to-contact";
import type { DbHandle } from "@/platform/db/client";
import { retryOnce, TRY_AGAIN } from "@/platform/db/errors";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { defaultDealTitle, initialStagePosition } from "../domain/deal";
import type { AddContactWithDealDeps, DealPerson, DealsDeps, StoppedCounts } from "./deal-ports";
import { MAX_BULK_CONVERT_IDS, BULK_TIME_BUDGET_MS, isUuid, PersonalCampaignError, isAlreadyConverted, type CreateDealInput, type DealFields, parseDealFields, pickStage, personOf } from "./deal-input";

export interface CreateDealResult {
  dealId: string;
  stopped: StoppedCounts;
  /** True when an earlier call with the same idempotency key created the deal. */
  replayed: boolean;
}

/**
 * One attempt of lead to contact plus deal, in one transaction: the idempotency lookup, the stages, the personal-campaign
 * rule, the conversion (locks, lifecycle re-read, stops), the deal and its event.
 */
function convertAndCreate(deps: DealsDeps, actor: Actor, person: DealPerson, fields: DealFields): Promise<CreateDealResult> {
  const organizationId = actor.organizationId;
  const personId = person.id;
  const key = fields.idempotencyKey;
  return deps.uow.run(
    async (tx) => {
      const replay = async () => {
        const prior = key ? await deps.store.byIdempotencyKey(tx, organizationId, personId, key) : null;
        return prior ? { ...prior, replayed: true } : null;
      };
      const early = await replay();
      if (early) return early;

      const now = deps.now();
      const stages = await deps.store.ensureStages(tx, organizationId);
      const stage = pickStage(stages, fields.stageId);
      const position = initialStagePosition(stage, fields.lostReason, now);
      // The early read answers fast without waiting on the person's locks. The guard repeats it under those locks, after the
      // lifecycle re-read, so an enrollment that committed in between still counts; the guard is the authority.
      const assertNoPersonalCampaign = async (handle: DbHandle) => {
        const live = await deps.outreach.liveEnrollmentSummary(organizationId, [personId], handle);
        if (personalCampaignSkip(actor, live.get(personId))) throw new PersonalCampaignError();
      };
      await assertNoPersonalCampaign(tx);

      const converted = await deps.convertLead(tx, { organizationId, personId, reason: "deal_created", actorUserId: actor.userId, now, guard: assertNoPersonalCampaign });
      if (!converted.changed) {
        // A concurrent call with the same key converted the person first and has committed by now (we waited on its locks).
        const late = await replay();
        if (late) return late;
        throw new ConflictError("This person is already a contact.", { code: "already_converted", dealId: await deps.store.primaryDealIdOfPerson(tx, organizationId, personId) });
      }

      const sourceEnrollmentId = (await deps.outreach.latestRepliedEnrollment(organizationId, [personId], tx)).get(personId) ?? null;
      const title = fields.title ?? defaultDealTitle(person);
      const deal = await deps.store.insert(tx, {
        organizationId,
        personId,
        ...position,
        title,
        ownerUserId: fields.ownerUserId,
        amountMinor: fields.amountMinor,
        currency: fields.currency,
        expectedCloseOn: fields.expectedCloseOn,
        sourceEnrollmentId,
        idempotencyKey: key,
        createdBy: actor.userId,
      });
      if (!deal) throw new ConflictError(TRY_AGAIN, { code: "try_again" });
      await deps.events.append(tx, {
        organizationId,
        personId,
        eventType: "deal.created",
        actorType: "human",
        actorUserId: actor.userId,
        meta: { dealId: deal.id, stageId: stage.id, stageName: stage.name, title, converted: true, stopped: converted.stopped },
      });
      return { dealId: deal.id, stopped: converted.stopped, replayed: false };
    },
    { lockTimeout: true },
  );
}

/**
 * Converts a lead and creates its first deal, all or nothing. 404 for a person outside the organization; 409 `already_converted`
 * (with the person's most recent deal id, or null) for a contact; 403 `personal_campaign`; 409 `try_again` after the retry;
 * 422 for an invalid stage, owner, amount or close date. A repeat with the same idempotency key replays the first result.
 */
export async function createDealFromLead(deps: DealsDeps, actor: Actor, personId: string, input: CreateDealInput = {}): Promise<CreateDealResult> {
  const person = await personOf(deps, actor, personId, "Lead");
  const fields = await parseDealFields(deps, actor, input);
  return retryOnce(() => convertAndCreate(deps, actor, person, fields));
}

export type BulkSkipReason = "already_converted" | "not_found" | "personal_campaign" | "failed" | "retryable";

export interface BulkCreateResult {
  created: Array<{ personId: string; dealId: string }>;
  skipped: Array<{ personId: string; reason: BulkSkipReason }>;
}

/**
 * Creates one deal per lead, one transaction per person, so one failure leaves the others. The stage and owner apply to every
 * deal and each title is the default. The server takes up to 200 ids, the size of the UI's chunks, and spends up to
 * `BULK_TIME_BUDGET_MS` on them: the ids left when the budget runs out come back `retryable`, and the dialog sends them once more.
 * A Lost stage needs a reason per deal, which the bulk call has no field for, so it is refused up front.
 */
export async function createDealsFromLeads(
  deps: DealsDeps,
  actor: Actor,
  ids: readonly string[],
  input: { stageId?: string | null; ownerId?: string | null } = {},
): Promise<BulkCreateResult> {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_BULK_CONVERT_IDS) throw new ValidationError(`Create deals for up to ${MAX_BULK_CONVERT_IDS} leads per request.`);
  const fields = await parseDealFields(deps, actor, { stageId: input.stageId, ownerId: input.ownerId });
  const result: BulkCreateResult = { created: [], skipped: [] };
  if (unique.length === 0) return result;
  if (fields.stageId) {
    const stages = await deps.uow.run((tx) => deps.store.ensureStages(tx, actor.organizationId));
    if (pickStage(stages, fields.stageId).kind === "lost") {
      throw new ValidationError("Bulk cannot start deals in a Lost stage, because each lost deal needs its own reason. Pick another stage.");
    }
  }
  const people = await deps.people.summaries(actor.organizationId, unique.filter(isUuid));
  const deadline = deps.now().getTime() + BULK_TIME_BUDGET_MS;
  for (const [index, personId] of unique.entries()) {
    if (deps.now().getTime() >= deadline) {
      for (const rest of unique.slice(index)) result.skipped.push({ personId: rest, reason: "retryable" });
      break;
    }
    const person = people.get(personId);
    if (!person) {
      result.skipped.push({ personId, reason: "not_found" });
      continue;
    }
    // A contact never becomes a lead again, so the snapshot is enough to skip it without a transaction.
    if (person.lifecycle === "contact") {
      result.skipped.push({ personId, reason: "already_converted" });
      continue;
    }
    try {
      const created = await retryOnce(() => convertAndCreate(deps, actor, person, fields));
      result.created.push({ personId, dealId: created.dealId });
    } catch (error) {
      const reason: BulkSkipReason = isAlreadyConverted(error)
        ? "already_converted"
        : error instanceof PersonalCampaignError
          ? "personal_campaign"
          : error instanceof NotFoundError
            ? "not_found"
            : error instanceof ConflictError && error.details?.code === "try_again"
              ? "retryable"
              : "failed";
      if (reason === "failed") console.error(`[deals] bulk create failed for person ${personId}: ${error instanceof Error ? error.message : String(error)}`);
      result.skipped.push({ personId, reason });
    }
  }
  return result;
}

/** A further deal for someone who is already a contact. No conversion runs. The idempotency key is required. */
export async function createDealForContact(deps: DealsDeps, actor: Actor, personId: string, input: CreateDealInput): Promise<{ dealId: string; replayed: boolean }> {
  const person = await personOf(deps, actor, personId, "Contact");
  if (!input.idempotencyKey) throw new ValidationError("Send an idempotency key with the deal.");
  const fields = await parseDealFields(deps, actor, input);
  if (person.lifecycle !== "contact") throw new ValidationError("This person is still a lead. Create the deal from the lead, which makes them a contact.");
  const key = fields.idempotencyKey as string;
  const organizationId = actor.organizationId;
  return contactGone(() => retryOnce(() =>
    deps.uow.run(
      async (tx) => {
        const prior = await deps.store.byIdempotencyKey(tx, organizationId, personId, key);
        if (prior) return { dealId: prior.dealId, replayed: true };
        const now = deps.now();
        const stage = pickStage(await deps.store.ensureStages(tx, organizationId), fields.stageId);
        const title = fields.title ?? defaultDealTitle(person);
        const deal = await deps.store.insert(tx, {
          organizationId,
          personId,
          ...initialStagePosition(stage, fields.lostReason, now),
          title,
          ownerUserId: fields.ownerUserId,
          amountMinor: fields.amountMinor,
          currency: fields.currency,
          expectedCloseOn: fields.expectedCloseOn,
          // The source enrollment is the reply that converted the person; a later deal has none.
          sourceEnrollmentId: null,
          idempotencyKey: key,
          createdBy: actor.userId,
        });
        if (!deal) {
          const winner = await deps.store.byIdempotencyKey(tx, organizationId, personId, key);
          if (winner) return { dealId: winner.dealId, replayed: true };
          throw new ConflictError(TRY_AGAIN, { code: "try_again" });
        }
        await deps.events.append(tx, {
          organizationId,
          personId,
          eventType: "deal.created",
          actorType: "human",
          actorUserId: actor.userId,
          meta: { dealId: deal.id, stageId: stage.id, stageName: stage.name, title, converted: false },
        });
        return { dealId: deal.id, replayed: false };
      },
      { lockTimeout: true },
    ),
  ));
}

export const CONTACT_GONE = "This contact no longer exists.";

/**
 * A contact delete that commits while a deal insert waits on the person row makes the insert fail on `deals_person_fk` (23503).
 * That answers 404, not a 500.
 */
async function contactGone<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (violatedConstraint(error, "23503") === "deals_person_fk") throw new NotFoundError(CONTACT_GONE);
    throw error;
  }
}

export type AddContactWithDealInput = Omit<AddContactInput, "creationKey"> & {
  deal?: Omit<CreateDealInput, "idempotencyKey"> | null;
  /** One per dialog open, 8 to 200 characters. It is the contact's creation key and the deal's idempotency key. */
  idempotencyKey: string;
};

/**
 * Add contact with "Also create a deal": the contact and its deal commit together or not at all. One transaction,
 * run once more on a lock error: Add contact (with its own replay by key), the replay of the deal by the same key, the stages,
 * the deal and its `deal.created` event. Errors: those of `addContact` (422, 409 `lead_exists`, `contact_exists`) and of
 * `createDealForContact` (422 stage, owner, amount, close date; 409 `try_again`).
 */
export async function addContactWithDeal(deps: AddContactWithDealDeps, actor: Actor, input: AddContactWithDealInput): Promise<{ personId: string; dealId: string; replayed: boolean }> {
  const key = parseCreationKey(input.idempotencyKey);
  const contact: AddContactInput = {
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    linkedinUrl: input.linkedinUrl,
    title: input.title,
    companyDomain: input.companyDomain,
    companyName: input.companyName,
    creationKey: key,
  };
  const fields = await parseDealFields(deps, actor, { ...input.deal, idempotencyKey: key });
  const organizationId = actor.organizationId;
  return retryOnce(() =>
    deps.uow.run(
      async (tx) => {
        const added = await deps.createContact(tx, actor, contact);
        const personId = added.personId;
        if (added.replayed) {
          const prior = await deps.store.byIdempotencyKey(tx, organizationId, personId, key);
          if (prior) return { personId, dealId: prior.dealId, replayed: true };
        }
        const now = deps.now();
        const stage = pickStage(await deps.store.ensureStages(tx, organizationId), fields.stageId);
        const parts = await deps.dealTitleParts(tx, organizationId, personId);
        const title = fields.title ?? defaultDealTitle(parts ?? { name: null, companyName: null });
        const deal = await deps.store.insert(tx, {
          organizationId,
          personId,
          ...initialStagePosition(stage, fields.lostReason, now),
          title,
          ownerUserId: fields.ownerUserId,
          amountMinor: fields.amountMinor,
          currency: fields.currency,
          expectedCloseOn: fields.expectedCloseOn,
          sourceEnrollmentId: null,
          idempotencyKey: key,
          createdBy: actor.userId,
        });
        if (!deal) throw new ConflictError(TRY_AGAIN, { code: "try_again" });
        await deps.events.append(tx, {
          organizationId,
          personId,
          eventType: "deal.created",
          actorType: "human",
          actorUserId: actor.userId,
          meta: { dealId: deal.id, stageId: stage.id, stageName: stage.name, title, converted: false },
        });
        return { personId, dealId: deal.id, replayed: false };
      },
      { lockTimeout: true },
    ),
  );
}
