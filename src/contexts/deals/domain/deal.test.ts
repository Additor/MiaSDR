import { describe, expect, it } from "vitest";
import { canDeleteDeal, defaultDealTitle, initialStagePosition, moveToStage, parseCloseDate, parseDealTitle, parseLostReason, type StagePosition } from "./deal";

const T0 = new Date("2026-10-01T00:00:00Z");
const NOW = new Date("2026-10-16T12:00:00Z");
const open = { id: "s-open", kind: "open" as const };
const open2 = { id: "s-open-2", kind: "open" as const };
const won = { id: "s-won", kind: "won" as const };
const won2 = { id: "s-won-2", kind: "won" as const };
const lost = { id: "s-lost", kind: "lost" as const };
const at = (stage: { id: string; kind: StagePosition["stageKind"] }, extra: Partial<StagePosition> = {}): StagePosition => ({
  stageId: stage.id,
  stageKind: stage.kind,
  closedAt: stage.kind === "open" ? null : T0,
  lostReason: stage.kind === "lost" ? "Budget" : null,
  stageChangedAt: T0,
  ...extra,
});

describe("deal title", () => {
  it("defaults to company and name, or the name, or the company", () => {
    expect(defaultDealTitle({ name: "Ada Lovelace", companyName: "Analytical" })).toBe("Analytical, Ada Lovelace");
    expect(defaultDealTitle({ name: "Ada Lovelace", companyName: null })).toBe("Ada Lovelace");
    expect(defaultDealTitle({ name: "  ", companyName: "Analytical" })).toBe("Analytical");
    expect(defaultDealTitle({ name: null, companyName: null })).toBe("New deal");
    expect(defaultDealTitle({ name: "x".repeat(150), companyName: "y".repeat(150) })).toHaveLength(200);
  });

  it("is 1 to 200 characters", () => {
    expect(parseDealTitle("  Renewal ")).toBe("Renewal");
    expect(() => parseDealTitle(" ")).toThrow("title");
    expect(() => parseDealTitle("x".repeat(201))).toThrow("200");
  });
});

describe("close date and lost reason", () => {
  it("takes a real calendar date or nothing", () => {
    expect(parseCloseDate("2026-12-31")).toBe("2026-12-31");
    expect(parseCloseDate(null)).toBeNull();
    expect(parseCloseDate("")).toBeNull();
    expect(() => parseCloseDate("2026-02-30")).toThrow("does not exist");
    expect(() => parseCloseDate("31/12/2026")).toThrow("YYYY-MM-DD");
  });

  it("needs a lost reason of at most 500 characters", () => {
    expect(parseLostReason(" Budget ")).toBe("Budget");
    expect(() => parseLostReason("")).toThrow("why");
    expect(() => parseLostReason(undefined)).toThrow("why");
    expect(() => parseLostReason("x".repeat(501))).toThrow("500");
  });
});

describe("stage moves", () => {
  it("a new deal in a closed stage is closed now, and a lost one needs a reason", () => {
    expect(initialStagePosition(open, undefined, NOW)).toEqual({ stageId: "s-open", stageKind: "open", closedAt: null, lostReason: null, stageChangedAt: NOW });
    expect(initialStagePosition(won, "ignored", NOW)).toMatchObject({ closedAt: NOW, lostReason: null });
    expect(initialStagePosition(lost, "Budget", NOW)).toMatchObject({ closedAt: NOW, lostReason: "Budget" });
    expect(() => initialStagePosition(lost, null, NOW)).toThrow("why");
  });

  it("into lost needs a reason and closes the deal", () => {
    expect(() => moveToStage(at(open), lost, undefined, NOW)).toThrow("why");
    expect(moveToStage(at(open), lost, "No budget", NOW)).toEqual({ stageId: "s-lost", stageKind: "lost", closedAt: NOW, lostReason: "No budget", stageChangedAt: NOW, moved: true });
  });

  it("out of lost clears the reason; back to open clears closed_at", () => {
    expect(moveToStage(at(lost), won, "ignored", NOW)).toMatchObject({ lostReason: null, closedAt: NOW, stageChangedAt: NOW });
    expect(moveToStage(at(lost), open, undefined, NOW)).toMatchObject({ lostReason: null, closedAt: null, stageChangedAt: NOW });
    expect(moveToStage(at(won), open, undefined, NOW)).toMatchObject({ closedAt: null });
  });

  it("between two stages of the same closed kind keeps closed_at", () => {
    expect(moveToStage(at(won), won2, undefined, NOW)).toMatchObject({ closedAt: T0, stageChangedAt: NOW, moved: true });
  });

  it("stage_changed_at changes only on a real move", () => {
    expect(moveToStage(at(open), open2, undefined, NOW)).toMatchObject({ stageChangedAt: NOW, moved: true, closedAt: null });
    expect(moveToStage(at(open), open, undefined, NOW)).toMatchObject({ stageChangedAt: T0, moved: false });
    expect(moveToStage(at(lost), lost, "New reason", NOW)).toMatchObject({ stageChangedAt: T0, moved: false, lostReason: "New reason", closedAt: T0 });
  });

  it("only an open deal can be deleted", () => {
    expect(canDeleteDeal({ stageKind: "open" })).toBe(true);
    expect(canDeleteDeal({ stageKind: "won" })).toBe(false);
    expect(canDeleteDeal({ stageKind: "lost" })).toBe(false);
  });
});
