import { describe, expect, it } from "vitest";
import { moveTarget, stageBlocker } from "./stage-rules";

const stages = [
  { name: "New", kind: "open", dealCount: 0 },
  { name: "Meeting", kind: "open", dealCount: 2 },
  { name: "Won", kind: "won", dealCount: 0 },
  { name: "Lost", kind: "lost", dealCount: 1 },
];

describe("stage settings rules", () => {
  it("moves a stage only among stages of its kind", () => {
    expect(moveTarget(stages, 0, 1)).toBe(1);
    expect(moveTarget(stages, 1, -1)).toBe(0);
    expect(moveTarget(stages, 0, -1)).toBeNull();
    expect(moveTarget(stages, 1, 1)).toBeNull();
    expect(moveTarget(stages, 3, 1)).toBeNull();
  });

  it("blocks deleting a stage with deals and the only stage of a kind", () => {
    expect(stageBlocker(stages, stages[1])).toBe("2 deals are in Meeting. Move them to another stage first.");
    expect(stageBlocker(stages, stages[3])).toBe("1 deal is in Lost. Move it to another stage first.");
    expect(stageBlocker(stages, stages[2])).toBe("The pipeline needs at least one won stage, so Won stays.");
    expect(stageBlocker(stages, stages[0])).toBeNull();
  });
});
