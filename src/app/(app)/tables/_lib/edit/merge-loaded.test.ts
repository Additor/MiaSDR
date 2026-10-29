import { describe, expect, it } from "vitest";
import { mergeLoaded } from "./merge-loaded";
import { addPending, buildBatches } from "./optimistic";
import type { GridRow } from "../data/types";

const row = (id: string, version: number, cells: Record<string, unknown> = {}, position = 0): GridRow => ({ id, position, cells, cellMeta: {}, version });

describe("mergeLoaded", () => {
  it("keeps a newer loaded row over an older page, so the next edit names the newer version", () => {
    // An edit response brought v2 while a table request that read v1 was still on its way.
    const merged = mergeLoaded([row("r1", 2, { a: "new" })], [row("r1", 1, { a: "old" })]);
    expect(merged[0].cells.a).toBe("new");
    const pending = addPending(new Map(), { rowId: "r1", columnKey: "b", value: "next" }, merged[0]);
    expect(buildBatches(pending, merged)[0].updates[0].expectedVersion).toBe(2);
  });

  it("takes the page row when the versions are equal or the page is newer", () => {
    const local = [row("r1", 3, { a: "local" }), row("r2", 3, { a: "local" })];
    const merged = mergeLoaded(local, [row("r1", 3, { a: "page" }), row("r2", 4, { a: "page" })]);
    expect(merged.map((r) => r.cells.a)).toEqual(["page", "page"]);
    expect(merged[1].version).toBe(4);
  });

  it("follows the page for which rows show and in what order", () => {
    const local = [row("r1", 9), row("r2", 1), row("r3", 1)];
    const merged = mergeLoaded(local, [row("r3", 1), row("r4", 1), row("r1", 2)]);
    expect(merged.map((r) => r.id)).toEqual(["r3", "r4", "r1"]);
    expect(merged[2].version).toBe(9);
  });
});
