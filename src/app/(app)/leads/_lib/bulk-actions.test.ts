import { describe, expect, it } from "vitest";
import { MAX_VISIBLE_CONTROLS, bulkActionModel, clearsSelectionOnKey } from "./bulk-actions";

const base = { selectedCount: 3, total: 120, filterActive: false, canSelectAll: true };

describe("bulkActionModel", () => {
  it("shows nothing without a selection", () => {
    expect(bulkActionModel({ ...base, selectedCount: 0 })).toEqual({ visible: [], menu: [] });
  });

  it("leads with Add to campaign and keeps deletes out of the visible controls", () => {
    const model = bulkActionModel(base);
    expect(model.visible[0]).toBe("addToCampaign");
    expect(model.visible).not.toContain("deleteSelected");
    expect(model.visible).toEqual(["addToCampaign", "export", "clear", "more"]);
  });

  it("puts the destructive items last in the menu", () => {
    const model = bulkActionModel({ ...base, filterActive: true });
    expect(model.menu.map((item) => item.id)).toEqual(["selectAll", "createDeals", "deleteSelected", "deleteMatching"]);
    const firstDestructive = model.menu.findIndex((item) => item.destructive);
    expect(model.menu.slice(firstDestructive).every((item) => item.destructive)).toBe(true);
    expect(model.menu.slice(0, firstDestructive).every((item) => !item.destructive)).toBe(true);
  });

  it("offers Delete all matching only while a filter is active", () => {
    expect(bulkActionModel(base).menu.map((item) => item.id)).not.toContain("deleteMatching");
    expect(bulkActionModel({ ...base, filterActive: true, total: 0 }).menu.map((item) => item.id)).not.toContain("deleteMatching");
  });

  it("drops Select all once every matching lead is ticked", () => {
    expect(bulkActionModel({ ...base, canSelectAll: false }).menu.map((item) => item.id)).toEqual(["createDeals", "deleteSelected"]);
  });

  it("hides the delete actions for a role that cannot delete, and the menu with them when it is empty", () => {
    const model = bulkActionModel({ ...base, canSelectAll: false, canDelete: false, lifecycle: "contact" });
    expect(model.menu).toEqual([]);
    expect(model.visible).toEqual(["addToCampaign", "export", "clear"]);
  });

  it("puts Create deals in the menu, never in the bar, and leaves it out for a list of contacts", () => {
    const model = bulkActionModel(base);
    expect(model.menu).toContainEqual({ id: "createDeals", destructive: false });
    expect(model.visible).not.toContain("createDeals");
    expect(bulkActionModel({ ...base, lifecycle: "all" }).menu.map((item) => item.id)).toContain("createDeals");
    expect(bulkActionModel({ ...base, lifecycle: "contact" }).menu.map((item) => item.id)).not.toContain("createDeals");
  });

  it("offers Delete all matching only for a list of leads", () => {
    const ids = (lifecycle?: "lead" | "contact" | "all") => bulkActionModel({ ...base, filterActive: true, lifecycle }).menu.map((item) => item.id);
    expect(ids()).toContain("deleteMatching");
    expect(ids("lead")).toContain("deleteMatching");
    expect(ids("all")).not.toContain("deleteMatching");
    expect(ids("contact")).not.toContain("deleteMatching");
    // Delete selected stays: the server keeps a contact and reports it as blocked.
    expect(ids("all")).toContain("deleteSelected");
  });

  it("never shows more than four controls", () => {
    for (const selectedCount of [1, 50, 5000]) {
      for (const filterActive of [false, true]) {
        for (const canSelectAll of [false, true]) {
          for (const canDelete of [false, true]) {
            for (const lifecycle of ["lead", "contact", "all"] as const) {
              const model = bulkActionModel({ selectedCount, total: 9000, filterActive, canSelectAll, canDelete, lifecycle });
              expect(model.visible.length).toBeLessThanOrEqual(MAX_VISIBLE_CONTROLS);
            }
          }
        }
      }
    }
  });
});

describe("clearsSelectionOnKey", () => {
  it("clears on Escape while rows are ticked", () => {
    expect(clearsSelectionOnKey({ key: "Escape", selectedCount: 2, defaultPrevented: false })).toBe(true);
  });
  it("ignores other keys, an empty selection and a key another widget handled", () => {
    expect(clearsSelectionOnKey({ key: "Enter", selectedCount: 2, defaultPrevented: false })).toBe(false);
    expect(clearsSelectionOnKey({ key: "Escape", selectedCount: 0, defaultPrevented: false })).toBe(false);
    expect(clearsSelectionOnKey({ key: "Escape", selectedCount: 2, defaultPrevented: true })).toBe(false);
  });
});
