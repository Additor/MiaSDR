import { describe, expect, it } from "vitest";
import { MAX_DELETE_IDS, summarizeDelete } from "./lead-management";
import type { BlockReason } from "./lead-ports";

const kept = (reason: BlockReason, n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `${reason}-${from + i}`, name: null, reason }));

describe("summarizeDelete", () => {
  it("counts the kept leads per reason, in the order of the per-lead reasons, with a line each", () => {
    const summary = summarizeDelete({ deleted: 7, blocked: [...kept("try_again", 2), ...kept("has_sends", 1), ...kept("linked_records", 3)] });
    expect(summary.deleted).toBe(7);
    expect(summary.kept).toEqual([
      { reason: "has_sends", count: 1, line: "1 lead already got messages." },
      { reason: "linked_records", count: 3, line: "3 leads have history, such as replies or conversations." },
      { reason: "try_again", count: 2, line: "2 leads were busy with another change. Try again." },
    ]);
  });

  it("offers a retry of the busy leads only, and do not contact only for a lead kept for its history", () => {
    const busy = summarizeDelete({ deleted: 0, blocked: kept("try_again", 2) });
    expect(busy).toMatchObject({ retryIds: ["try_again-0", "try_again-1"], suggestDoNotContact: false });
    const mixed = summarizeDelete({ deleted: 0, blocked: [...kept("personal_campaign_sends", 1), ...kept("try_again", 1)] });
    expect(mixed).toMatchObject({ retryIds: ["try_again-0"], suggestDoNotContact: true });
    expect(mixed.kept[0].line).toBe("1 lead is in another member's personal campaign. Ask its creator, an owner or an admin.");
    expect(summarizeDelete({ deleted: 3, blocked: [] })).toEqual({ deleted: 3, kept: [], retryIds: [], suggestDoNotContact: false });
  });

  it("caps the retry at one selection", () => {
    expect(summarizeDelete({ deleted: 0, blocked: kept("try_again", MAX_DELETE_IDS + 5) }).retryIds).toHaveLength(MAX_DELETE_IDS);
  });
});
