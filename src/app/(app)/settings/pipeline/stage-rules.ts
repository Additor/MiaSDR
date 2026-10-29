import { formatCount } from "@/shared/format-number";

/** What the stage settings allow before asking the server, which enforces the same rules (deals/domain/stages.ts). */

interface StageLike {
  name: string;
  kind: string;
  dealCount: number;
}

/** The index a stage swaps with when it moves, or null. Open stays before Won and Won before Lost, so a stage moves only among its kind. */
export function moveTarget(stages: readonly StageLike[], index: number, direction: -1 | 1): number | null {
  const other = index + direction;
  if (other < 0 || other >= stages.length) return null;
  return stages[other].kind === stages[index].kind ? other : null;
}

/** Why the stage cannot be deleted, or null when it can. */
export function stageBlocker(stages: readonly StageLike[], stage: StageLike): string | null {
  if (stage.dealCount > 0) {
    const count = stage.dealCount;
    return `${formatCount(count)} deal${count === 1 ? " is" : "s are"} in ${stage.name}. Move ${count === 1 ? "it" : "them"} to another stage first.`;
  }
  if (stages.filter((s) => s.kind === stage.kind).length === 1) return `The pipeline needs at least one ${stage.kind} stage, so ${stage.name} stays.`;
  return null;
}
