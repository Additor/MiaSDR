import { describe, expect, it } from "vitest";
import { MIA_RUN_TOOLS } from "@/contexts/mia/domain/mia-run";

/**
 * What each kind of Mia run can reach. A run may hold text from outside, data from inside or a way out to the network, and
 * a run that holds all three can be told by a web page or a reply to send one to the other. A change here needs that thought.
 * "Mia" in docs/decisions.md.
 */
describe("Mia's tools", () => {
  it("pins the tools of each capability", () => {
    expect(MIA_RUN_TOOLS).toEqual({
      brain_fill_url: ["fetch_page", "suggest_item", "finish"],
      brain_fill_text: ["suggest_item", "finish"],
      brain_sort: ["suggest_item", "finish"],
    });
  });

  it("gives network access only to a run that reads nothing from inside the organization", () => {
    const readsInside = (tool: string) => /^(read|list|search)_/.test(tool);
    for (const tools of Object.values(MIA_RUN_TOOLS)) {
      if (tools.includes("fetch_page")) expect(tools.filter(readsInside)).toEqual([]);
    }
  });

  it("offers no tool that sends, or that writes to Brain", () => {
    const allowed = new Set(["fetch_page", "suggest_item", "finish"]);
    expect(Object.values(MIA_RUN_TOOLS).flat().filter((tool) => !allowed.has(tool))).toEqual([]);
  });
});
