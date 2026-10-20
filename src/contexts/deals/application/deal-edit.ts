import type { DbHandle } from "@/platform/db/client";
import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { canDeleteDeal, moveToStage, parseCloseDate, parseDealTitle } from "../domain/deal";
import type { DealPatch, DealRow, DealsDeps } from "./deal-ports";
import { isUuid, parseMoney, assertOwner } from "./deal-input";
import { type DealView, getDeal } from "./deal-reads";

function parseVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ValidationError("Send the deal's current version.");
  return value;
}

async function lockCurrent(deps: DealsDeps, tx: DbHandle, actor: Actor, dealId: string, expectedVersion: number | undefined): Promise<DealRow> {
  const deal = await deps.store.lock(tx, actor.organizationId, dealId);
  if (!deal) throw new NotFoundError("Deal not found");
  if (expectedVersion !== undefined && deal.version !== expectedVersion) {
    throw new ConflictError("Someone changed this deal since you opened it. Reload it and try again.", { code: "stale_version", version: deal.version });
  }
  return deal;
}

/** Moves a deal to another stage of the pipeline. Mark won and Mark lost are this call with a Won or Lost stage. */
export async function moveDealStage(deps: DealsDeps, actor: Actor, dealId: string, input: { stageId: string; expectedVersion: number; lostReason?: string | null }): Promise<DealView> {
  if (!isUuid(dealId)) throw new NotFoundError("Deal not found");
  const expectedVersion = parseVersion(input.expectedVersion);
  if (!isUuid(input.stageId)) throw new ValidationError("Pick a stage of this pipeline.");
  await deps.uow.run(async (tx) => {
    const deal = await lockCurrent(deps, tx, actor, dealId, expectedVersion);
    const stages = await deps.store.listStages(actor.organizationId, tx);
    const target = stages.find((s) => s.id === input.stageId);
    if (!target) throw new ValidationError("Pick a stage of this pipeline.");
    const now = deps.now();
    const next = moveToStage(deal, target, input.lostReason, now);
    if (!next.moved && next.lostReason === deal.lostReason) return;
    const { moved, ...patch } = next;
    await deps.store.update(tx, actor.organizationId, dealId, patch, now);
    const from = stages.find((s) => s.id === deal.stageId);
    await deps.events.append(tx, {
      organizationId: actor.organizationId,
      personId: deal.personId,
      eventType: moved ? "deal.stage_moved" : "deal.updated",
      actorType: "human",
      actorUserId: actor.userId,
      fromData: { stageId: deal.stageId, stageName: from?.name ?? null, stageKind: deal.stageKind },
      toData: { stageId: target.id, stageName: target.name, stageKind: target.kind, lostReason: next.lostReason },
      meta: moved ? { dealId } : { dealId, fields: ["lostReason"] },
    });
  });
  return getDeal(deps, actor, dealId);
}

export interface UpdateDealInput {
  expectedVersion: number;
  title?: string;
  ownerId?: string | null;
  amount?: string | number | null;
  currency?: string | null;
  expectedCloseOn?: string | null;
}

/** Edits the fields a person fills in. The stage moves through `moveDealStage`. Amount and currency change together. */
export async function updateDeal(deps: DealsDeps, actor: Actor, dealId: string, input: UpdateDealInput): Promise<DealView> {
  if (!isUuid(dealId)) throw new NotFoundError("Deal not found");
  const expectedVersion = parseVersion(input.expectedVersion);
  const patch: DealPatch = {};
  if (input.title !== undefined) patch.title = parseDealTitle(input.title);
  if (input.ownerId !== undefined) {
    await assertOwner(deps, actor, input.ownerId);
    patch.ownerUserId = input.ownerId;
  }
  if (input.expectedCloseOn !== undefined) patch.expectedCloseOn = parseCloseDate(input.expectedCloseOn);
  await deps.uow.run(async (tx) => {
    const deal = await lockCurrent(deps, tx, actor, dealId, expectedVersion);
    if (input.amount !== undefined || input.currency !== undefined) {
      // The stored minor units belong to the stored currency, so a new currency needs the amount too.
      if (input.amount === undefined) throw new ValidationError("Send the amount together with its currency.");
      Object.assign(patch, parseMoney(input.amount, input.currency ?? deal.currency));
    }
    const fields = Object.keys(patch);
    if (fields.length === 0) return;
    await deps.store.update(tx, actor.organizationId, dealId, patch, deps.now());
    await deps.events.append(tx, {
      organizationId: actor.organizationId,
      personId: deal.personId,
      eventType: "deal.updated",
      actorType: "human",
      actorUserId: actor.userId,
      meta: { dealId, fields },
    });
  });
  return getDeal(deps, actor, dealId);
}

/** Deletes an open deal. The person stays a contact. A won or lost deal is history and stays. */
export async function deleteDeal(deps: DealsDeps, actor: Actor, dealId: string, input: { expectedVersion?: number } = {}): Promise<void> {
  if (!isUuid(dealId)) throw new NotFoundError("Deal not found");
  const expectedVersion = input.expectedVersion === undefined ? undefined : parseVersion(input.expectedVersion);
  await deps.uow.run(async (tx) => {
    const deal = await lockCurrent(deps, tx, actor, dealId, expectedVersion);
    if (!canDeleteDeal(deal)) throw new ConflictError("Only an open deal can be deleted. A won or lost deal stays as history.", { code: "deal_closed" });
    await deps.store.delete(tx, actor.organizationId, dealId);
    await deps.events.append(tx, {
      organizationId: actor.organizationId,
      personId: deal.personId,
      eventType: "deal.deleted",
      actorType: "human",
      actorUserId: actor.userId,
      meta: { dealId, title: deal.title },
    });
  });
}
