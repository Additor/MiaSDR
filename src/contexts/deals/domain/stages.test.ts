import { describe, expect, it } from "vitest";
import { DEFAULT_DEAL_STAGES, firstOpenStage, insertStage, isLastOfKind, parseStageName, reorderStages, stageListProblem, type StageLike } from "./stages";

const stage = (id: string, kind: StageLike["kind"], position: number): StageLike => ({ id, name: id, kind, position });
const defaults = (): StageLike[] => DEFAULT_DEAL_STAGES.map((s) => ({ ...s, id: s.name.toLowerCase() }));

describe("default stages", () => {
  it("are New, Meeting and Proposal open, then Won, then Lost", () => {
    expect(DEFAULT_DEAL_STAGES.map((s) => [s.name, s.kind, s.position])).toEqual([
      ["New", "open", 1],
      ["Meeting", "open", 2],
      ["Proposal", "open", 3],
      ["Won", "won", 4],
      ["Lost", "lost", 5],
    ]);
    expect(stageListProblem(DEFAULT_DEAL_STAGES)).toBeNull();
  });
});

describe("stage list rules", () => {
  it("needs one stage of each kind and open before won before lost", () => {
    expect(stageListProblem([{ kind: "open" }, { kind: "won" }])).toMatch("lost");
    expect(stageListProblem([{ kind: "won" }, { kind: "lost" }])).toMatch("open");
    expect(stageListProblem([{ kind: "open" }, { kind: "lost" }, { kind: "won" }])).toMatch("Open stages come first");
    expect(stageListProblem([{ kind: "won" }, { kind: "open" }, { kind: "lost" }])).toMatch("Open stages come first");
    expect(stageListProblem([{ kind: "open" }, { kind: "open" }, { kind: "won" }, { kind: "won" }, { kind: "lost" }])).toBeNull();
  });

  it("inserts a new stage after the last one of its kind and renumbers", () => {
    const list = defaults();
    expect(insertStage(list, stage("demo", "open", 0)).map((s) => [s.id, s.position])).toEqual([["new", 1], ["meeting", 2], ["proposal", 3], ["demo", 4], ["won", 5], ["lost", 6]]);
    expect(insertStage(list, stage("signed", "won", 0)).map((s) => s.id)).toEqual(["new", "meeting", "proposal", "won", "signed", "lost"]);
    expect(insertStage(list, stage("gone", "lost", 0)).map((s) => s.id)).toEqual(["new", "meeting", "proposal", "won", "lost", "gone"]);
    expect(insertStage([stage("won", "won", 1), stage("lost", "lost", 2)], stage("first", "open", 0)).map((s) => s.id)).toEqual(["first", "won", "lost"]);
  });

  it("reorders when every id is named once and the kinds stay in order", () => {
    const list = defaults();
    expect(reorderStages(list, ["proposal", "new", "meeting", "won", "lost"]).map((s) => [s.id, s.position])).toEqual([["proposal", 1], ["new", 2], ["meeting", 3], ["won", 4], ["lost", 5]]);
    expect(() => reorderStages(list, ["new", "won", "meeting", "proposal", "lost"])).toThrow("Open stages come first");
    expect(() => reorderStages(list, ["new", "meeting", "proposal", "won"])).toThrow("every stage");
    expect(() => reorderStages(list, ["new", "new", "proposal", "won", "lost"])).toThrow("every stage");
    expect(() => reorderStages(list, ["new", "meeting", "proposal", "won", "other"])).toThrow("every stage");
    expect(() => reorderStages(list, [])).toThrow("every stage");
  });

  it("knows the last stage of a kind and the first open stage", () => {
    const list = defaults();
    expect(isLastOfKind(list, "won")).toBe(true);
    expect(isLastOfKind(list, "lost")).toBe(true);
    expect(isLastOfKind(list, "new")).toBe(false);
    expect(isLastOfKind(list, "missing")).toBe(false);
    expect(firstOpenStage([stage("b", "open", 2), stage("a", "open", 1), stage("w", "won", 3)])?.id).toBe("a");
    expect(firstOpenStage([stage("w", "won", 1)])).toBeNull();
  });

  it("trims a stage name and keeps it to 60 characters", () => {
    expect(parseStageName("  Demo  ")).toBe("Demo");
    expect(() => parseStageName("   ")).toThrow("Name the stage");
    expect(() => parseStageName("x".repeat(61))).toThrow("60");
    expect(parseStageName("x".repeat(60))).toHaveLength(60);
  });
});
