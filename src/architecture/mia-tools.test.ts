import { describe, expect, it } from "vitest";
import { chatTools } from "@/contexts/mia/application/chat-tools";
import { MIA_CHAT_TOOLS } from "@/contexts/mia/domain/mia-chat";
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
      // Replies and a profile are outside text, and the lead and its ICP inside data, so a fit check gets no tool at all.
      lead_fit: [],
    });
  });

  it("gives network access only to a run that reads nothing from inside the organization", () => {
    const readsInside = (tool: string) => /^(read|list|search)_/.test(tool);
    for (const tools of Object.values(MIA_RUN_TOOLS)) {
      if (tools.includes("fetch_page")) expect(tools.filter(readsInside)).toEqual([]);
    }
  });

  it("pins the chat's tools: each reads, and none opens the web, writes or suggests", () => {
    // A chat holds replies and the organization's data together, so it must have no way out and nothing that changes a record.
    expect(MIA_CHAT_TOOLS).toEqual(["search_leads", "read_lead", "read_company", "read_conversation", "read_fit", "list_brain_items", "read_brain_item"]);
    expect(MIA_CHAT_TOOLS.filter((tool) => !/^(read|list|search)_/.test(tool))).toEqual([]);
  });

  it("builds a chat's tools from the pinned list and from nothing else", () => {
    const turn = { organizationId: "o", userId: "u", threadId: "t", turnId: "r", turnToken: "k", answerId: "a", personId: null, history: [] };
    const tools = chatTools({ turn, reads: {} as never, store: {} as never, onPart: () => undefined });
    expect(tools.map((t) => t.name)).toEqual([...MIA_CHAT_TOOLS]);
  });

  it("offers no tool that sends, or that writes to Brain", () => {
    const allowed = new Set(["fetch_page", "suggest_item", "finish"]);
    expect(Object.values(MIA_RUN_TOOLS).flat().filter((tool) => !allowed.has(tool))).toEqual([]);
  });
});
