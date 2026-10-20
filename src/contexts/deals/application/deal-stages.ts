import { ConflictError, NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import type { DbHandle } from "@/platform/db/client";
import { DEFAULT_DEAL_STAGES, insertStage, isLastOfKind, isStageKind, MAX_STAGES, parseStageName, renumber, reorderStages, type DealStageKind } from "../domain/stages";
import type { DealsDeps, DealStage } from "./deal-ports";
import { isUuid, violatedConstraint } from "./deals";

/*
 * Settings > Pipeline stages. Every write takes the organization's pipeline lock first, so two admins editing at once see each
 * other's result, and each keeps one open, one won and one lost stage with open before won before lost. Each write adds one
 * audit row. A read never writes: an organization without stages sees the defaults flagged `virtual`, and its first write
 * creates them.
 */

export interface StageSetting {
  /** Null for a default stage that does not exist yet (`virtual`). */
  id: string | null;
  name: string;
  kind: DealStageKind;
  position: number;
  /** Deals in the stage; a stage with deals cannot be deleted. */
  dealCount: number;
}

export interface StageSettings {
  virtual: boolean;
  stages: StageSetting[];
}

export async function listDealStages(deps: DealsDeps, actor: Actor): Promise<StageSettings> {
  const [stages, counts] = await Promise.all([deps.store.listStages(actor.organizationId), deps.store.stageDealCounts(actor.organizationId)]);
  if (stages.length === 0) return { virtual: true, stages: DEFAULT_DEAL_STAGES.map((s) => ({ id: null, ...s, dealCount: 0 })) };
  return { virtual: false, stages: stages.map((s) => ({ ...s, dealCount: counts.get(s.id) ?? 0 })) };
}

/** Runs one settings write under the pipeline lock, with the defaults created first for an organization that has none. */
async function underLock(deps: DealsDeps, actor: Actor, write: (tx: DbHandle, stages: DealStage[]) => Promise<void>): Promise<StageSettings> {
  await deps.uow.run(async (tx) => {
    const locked = await deps.store.lockStages(tx, actor.organizationId);
    const stages = locked.length > 0 ? locked : await deps.store.ensureStages(tx, actor.organizationId);
    await write(tx, stages);
  });
  return listDealStages(deps, actor);
}

const nameTaken = (stages: DealStage[], name: string, except?: string) => stages.some((s) => s.id !== except && s.name.toLowerCase() === name.toLowerCase());

/** Writes the positions of `next` that differ from `current`. */
async function writePositions(deps: DealsDeps, tx: DbHandle, actor: Actor, current: DealStage[], next: DealStage[]) {
  const before = new Map(current.map((s) => [s.id, s.position]));
  const changed = next.filter((s) => before.get(s.id) !== s.position).map((s) => ({ id: s.id, position: s.position }));
  if (changed.length > 0) await deps.store.setPositions(tx, actor.organizationId, changed, deps.now());
}

/** "Create default stages" for an organization that has none yet. A pipeline that already has stages stays as it is. */
export async function createDefaultDealStages(deps: DealsDeps, actor: Actor): Promise<StageSettings> {
  await deps.uow.run(async (tx) => {
    if ((await deps.store.lockStages(tx, actor.organizationId)).length > 0) return;
    const created = await deps.store.ensureStages(tx, actor.organizationId);
    await deps.store.audit(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, action: "deal_stage.defaults_created", entityType: "deal_stage", meta: { names: created.map((s) => s.name) } });
  });
  return listDealStages(deps, actor);
}

/** Adds a stage after the last stage of its kind. */
export async function createDealStage(deps: DealsDeps, actor: Actor, input: { name: unknown; kind: unknown }): Promise<StageSettings> {
  const name = parseStageName(input.name);
  if (!isStageKind(input.kind)) throw new ValidationError("A stage is open, won or lost.");
  const kind = input.kind;
  return underLock(deps, actor, async (tx, stages) => {
    if (stages.length >= MAX_STAGES) throw new ValidationError(`A pipeline holds up to ${MAX_STAGES} stages.`);
    if (nameTaken(stages, name)) throw new ConflictError(`A stage named "${name}" already exists.`, { code: "name_taken" });
    // The new stage takes a position past the end first, then the list is renumbered in its final order.
    const end = Math.max(0, ...stages.map((s) => s.position)) + 1;
    const created = await deps.store.insertStage(tx, actor.organizationId, { name, kind, position: end });
    const next = insertStage(stages, created);
    await writePositions(deps, tx, actor, [...stages, created], next);
    await deps.store.audit(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, action: "deal_stage.created", entityType: "deal_stage", entityId: created.id, meta: { name, kind } });
  });
}

export async function renameDealStage(deps: DealsDeps, actor: Actor, stageId: string, input: { name: unknown }): Promise<StageSettings> {
  if (!isUuid(stageId)) throw new NotFoundError("Stage not found");
  const name = parseStageName(input.name);
  return underLock(deps, actor, async (tx, stages) => {
    const stage = stages.find((s) => s.id === stageId);
    if (!stage) throw new NotFoundError("Stage not found");
    if (stage.name === name) return;
    if (nameTaken(stages, name, stageId)) throw new ConflictError(`A stage named "${name}" already exists.`, { code: "name_taken" });
    await deps.store.renameStage(tx, actor.organizationId, stageId, name, deps.now());
    await deps.store.audit(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, action: "deal_stage.renamed", entityType: "deal_stage", entityId: stageId, meta: { from: stage.name, to: name } });
  });
}

/** Puts the stages in the order of `ids`, which names every stage once. Open stays before Won, Won before Lost. */
export async function reorderDealStages(deps: DealsDeps, actor: Actor, ids: readonly string[]): Promise<StageSettings> {
  return underLock(deps, actor, async (tx, stages) => {
    const next = reorderStages(stages, ids);
    await writePositions(deps, tx, actor, stages, next);
    await deps.store.audit(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, action: "deal_stage.reordered", entityType: "deal_stage", meta: { ids: next.map((s) => s.id) } });
  });
}

const stageInUse = (count: number) =>
  new ConflictError(`${count} deal${count === 1 ? " is" : "s are"} in this stage. Move ${count === 1 ? "it" : "them"} first.`, { code: "stage_in_use", count });

/**
 * Deletes an empty stage. 409 `stage_in_use` with the deal count, 409 `last_of_kind` for the only stage of its kind. Deal
 * inserts and moves do not take the pipeline lock, so a deal can land in the stage after the count: the delete then meets
 * `deals_stage_fk`, the transaction rolls back, and the answer is `stage_in_use` with a count read after the rollback.
 */
export async function deleteDealStage(deps: DealsDeps, actor: Actor, stageId: string): Promise<StageSettings> {
  if (!isUuid(stageId)) throw new NotFoundError("Stage not found");
  try {
    return await underLock(deps, actor, async (tx, stages) => {
      const stage = stages.find((s) => s.id === stageId);
      if (!stage) throw new NotFoundError("Stage not found");
      const count = (await deps.store.stageDealCounts(actor.organizationId, tx)).get(stageId) ?? 0;
      if (count > 0) throw stageInUse(count);
      if (isLastOfKind(stages, stageId)) throw new ConflictError(`The pipeline needs at least one ${stage.kind} stage.`, { code: "last_of_kind" });
      await deps.store.deleteStage(tx, actor.organizationId, stageId);
      const rest = stages.filter((s) => s.id !== stageId);
      await writePositions(deps, tx, actor, rest, renumber(rest));
      await deps.store.audit(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, action: "deal_stage.deleted", entityType: "deal_stage", entityId: stageId, meta: { name: stage.name, kind: stage.kind } });
    });
  } catch (error) {
    if (violatedConstraint(error, "23503") !== "deals_stage_fk") throw error;
    const count = (await deps.store.stageDealCounts(actor.organizationId)).get(stageId) ?? 0;
    throw stageInUse(Math.max(count, 1));
  }
}
