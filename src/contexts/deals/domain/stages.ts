import { ValidationError } from "@/shared/errors";

/**
 * The organization's deal pipeline: one ordered list of stages. A stage's kind is `open`, `won` or `lost` and never
 * changes (a trigger on `deal_stages`). The list always holds at least one stage of each kind, and every open stage comes before
 * every won stage, which come before every lost stage. Deal stages carry no stop rule: those belong to reply categories.
 */

export const DEAL_STAGE_KINDS = ["open", "won", "lost"] as const;
export type DealStageKind = (typeof DEAL_STAGE_KINDS)[number];

export const MAX_STAGE_NAME = 60;
export const MAX_STAGES = 30;

export interface StageDraft {
  name: string;
  kind: DealStageKind;
  position: number;
}

/** The stages an organization starts with. */
export const DEFAULT_DEAL_STAGES: readonly StageDraft[] = [
  { name: "New", kind: "open", position: 1 },
  { name: "Meeting", kind: "open", position: 2 },
  { name: "Proposal", kind: "open", position: 3 },
  { name: "Won", kind: "won", position: 4 },
  { name: "Lost", kind: "lost", position: 5 },
];

export const isStageKind = (value: unknown): value is DealStageKind => typeof value === "string" && (DEAL_STAGE_KINDS as readonly string[]).includes(value);

const KIND_RANK: Record<DealStageKind, number> = { open: 0, won: 1, lost: 2 };

export function parseStageName(name: unknown): string {
  const value = typeof name === "string" ? name.trim() : "";
  if (value.length === 0) throw new ValidationError("Name the stage.");
  if (value.length > MAX_STAGE_NAME) throw new ValidationError(`Keep the stage name to ${MAX_STAGE_NAME} characters.`);
  return value;
}

export interface StageLike {
  id: string;
  name: string;
  kind: DealStageKind;
  position: number;
}

const byPosition = <T extends StageLike>(stages: readonly T[]) => [...stages].sort((a, b) => a.position - b.position);

/** What is wrong with an ordered stage list, or null. Order is the array order. */
export function stageListProblem(ordered: readonly Pick<StageLike, "kind">[]): string | null {
  for (const kind of DEAL_STAGE_KINDS) {
    if (!ordered.some((s) => s.kind === kind)) return `The pipeline needs at least one ${kind} stage.`;
  }
  for (let i = 1; i < ordered.length; i += 1) {
    if (KIND_RANK[ordered[i].kind] < KIND_RANK[ordered[i - 1].kind]) return "Open stages come first, then Won, then Lost.";
  }
  return null;
}

/** Positions 1..n in array order. */
export function renumber<T extends StageLike>(ordered: readonly T[]): T[] {
  return ordered.map((stage, index) => ({ ...stage, position: index + 1 }));
}

/** Where a new stage of `kind` goes: after the last stage of its kind, else before the first stage of a later kind. */
export function insertStage<T extends StageLike>(stages: readonly T[], added: T): T[] {
  const ordered = byPosition(stages);
  let index = ordered.length;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (KIND_RANK[ordered[i].kind] <= KIND_RANK[added.kind]) {
      index = i + 1;
      break;
    }
    index = i;
  }
  return renumber([...ordered.slice(0, index), added, ...ordered.slice(index)]);
}

/** A reorder names every stage id once. The result keeps open before won before lost. */
export function reorderStages<T extends StageLike>(stages: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(stages.map((s) => [s.id, s]));
  if (ids.length !== stages.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
    throw new ValidationError("List every stage of the pipeline once, in the new order.");
  }
  const ordered = ids.map((id) => byId.get(id) as T);
  const problem = stageListProblem(ordered);
  if (problem) throw new ValidationError(problem);
  return renumber(ordered);
}

/** True when `id` is the only stage of its kind, so deleting it would leave the pipeline without that kind. */
export function isLastOfKind(stages: readonly StageLike[], id: string): boolean {
  const stage = stages.find((s) => s.id === id);
  return Boolean(stage) && stages.filter((s) => s.kind === stage?.kind).length === 1;
}

/** The stage a new deal starts in when the caller names none: the first open stage. */
export function firstOpenStage<T extends StageLike>(stages: readonly T[]): T | null {
  return byPosition(stages).find((s) => s.kind === "open") ?? null;
}
