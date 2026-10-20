import { describe, expect, it } from "vitest";
import type { Actor } from "@/shared/errors";
import { getTablePage } from "./row-management";

const actor: Actor = { userId: "u", organizationId: "o", role: "owner" };

function fakeDeps() {
  const scans: string[][] = [];
  const deps = {
    structure: {
      getTable: async () => ({ id: "t", view: {} }),
      getUserView: async () => null,
      columnCoverage: async (_org: string, _table: string, keys: string[]) => {
        scans.push(keys);
        return { name: 75 };
      },
    },
    columns: { list: async () => [{ id: "c", tableId: "t", key: "name", name: "Name", type: "text", config: {}, dependsOn: [], position: 1, autoRun: false }] },
    rows: {
      currentCursor: async () => "cursor",
      list: async () => [],
      count: async () => 4,
      activeJobs: async () => [],
    },
  };
  return { deps: deps as never, scans };
}

describe("getTablePage fill rate", () => {
  it("scans the columns on the first page", async () => {
    const { deps, scans } = fakeDeps();
    const page = await getTablePage(deps, actor, "t", { limit: 2 });
    expect(scans).toEqual([["name"]]);
    expect(page.coverage).toEqual({ name: 75 });
  });

  it("skips the scan on a later page", async () => {
    const { deps, scans } = fakeDeps();
    const page = await getTablePage(deps, actor, "t", { limit: 2, offset: 2 });
    expect(scans).toEqual([]);
    expect(page.coverage).toEqual({});
  });

  it("skips the scan when the caller turns coverage off", async () => {
    const { deps, scans } = fakeDeps();
    const page = await getTablePage(deps, actor, "t", { limit: 2, search: "x", coverage: false });
    expect(scans).toEqual([]);
    expect(page.coverage).toEqual({});
  });
});
