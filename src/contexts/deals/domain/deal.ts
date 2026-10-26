import { ValidationError } from "@/shared/errors";
import type { DealStageKind } from "./stages";

/**
 * Deal rules. A person fills in title, stage, owner, amount with currency and expected close date. The system keeps
 * `closed_at` (set while the stage is Won or Lost), `lost_reason` (set only in a Lost stage), `stage_changed_at` (moves only
 * on a stage move) and `version` (optimistic lock). The CHECKs on `deals` hold the same rules on the row.
 */

export const MAX_DEAL_TITLE = 200;
export const MAX_LOST_REASON = 500;

/** "{Company}, {Name}", or the name alone, or the company alone, cut to the title limit. */
export function defaultDealTitle(person: { name: string | null; companyName: string | null }): string {
  const name = person.name?.trim() || null;
  const company = person.companyName?.trim() || null;
  const title = company && name ? `${company}, ${name}` : (name ?? company ?? "New deal");
  return title.slice(0, MAX_DEAL_TITLE);
}

export function parseDealTitle(title: unknown): string {
  const value = typeof title === "string" ? title.trim() : "";
  if (value.length === 0) throw new ValidationError("Give the deal a title.");
  if (value.length > MAX_DEAL_TITLE) throw new ValidationError(`Keep the title to ${MAX_DEAL_TITLE} characters.`);
  return value;
}

export function parseLostReason(reason: unknown): string {
  const value = typeof reason === "string" ? reason.trim() : "";
  if (value.length === 0) throw new ValidationError("Say why the deal was lost.");
  if (value.length > MAX_LOST_REASON) throw new ValidationError(`Keep the reason to ${MAX_LOST_REASON} characters.`);
  return value;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date in the form YYYY-MM-DD, or null to clear it. */
export function parseCloseDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const match = typeof value === "string" ? DAY.exec(value) : null;
  if (!match) throw new ValidationError("Use an expected close date in the form YYYY-MM-DD.");
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new ValidationError("That date does not exist.");
  return value as string;
}

export interface StagePosition {
  stageId: string;
  stageKind: DealStageKind;
  closedAt: Date | null;
  lostReason: string | null;
  stageChangedAt: Date;
}

/** The stage columns of a new deal in `stage`. A Lost stage needs a reason. */
export function initialStagePosition(stage: { id: string; kind: DealStageKind }, lostReason: unknown, now: Date): StagePosition {
  return {
    stageId: stage.id,
    stageKind: stage.kind,
    closedAt: stage.kind === "open" ? null : now,
    lostReason: stage.kind === "lost" ? parseLostReason(lostReason) : null,
    stageChangedAt: now,
  };
}

/**
 * A move to `target`. A Lost stage needs a reason; any other stage clears it. An open stage clears `closed_at`; a move into
 * Won or Lost from another kind sets it to `now`, and a move between two stages of the same closed kind keeps it.
 * `stage_changed_at` changes only when the stage changes: "moving" to the current stage only updates the lost reason.
 */
export function moveToStage(current: StagePosition, target: { id: string; kind: DealStageKind }, lostReason: unknown, now: Date): StagePosition & { moved: boolean } {
  const moved = target.id !== current.stageId;
  const reason = target.kind === "lost" ? parseLostReason(lostReason) : null;
  let closedAt: Date | null = null;
  if (target.kind !== "open") closedAt = current.stageKind === target.kind && current.closedAt ? current.closedAt : now;
  return {
    stageId: target.id,
    stageKind: target.kind,
    closedAt,
    lostReason: reason,
    stageChangedAt: moved ? now : current.stageChangedAt,
    moved,
  };
}

/** Only a deal in an open stage can be deleted; a closed deal is history. */
export const canDeleteDeal = (deal: { stageKind: DealStageKind }) => deal.stageKind === "open";
