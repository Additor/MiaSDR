import { describe, expect, it } from "vitest";
import { actionsHref, actionsViewFrom, threadQueryFromActions } from "./actions-query";

describe("the view a row hands to its thread", () => {
  it("keeps the scope and the filters, drops empty values and keys it does not know", () => {
    const view = actionsViewFrom({ scope: "others", category: ["interested", "x"], channel: "", from: "actions", cursor: "abc", errorsOnly: "1", q: "acme" });
    expect(view).toEqual({ scope: "others", category: "interested", errorsOnly: "1" });
  });

  it("builds the Actions link and the thread query from it", () => {
    expect(actionsHref({})).toBe("/actions");
    expect(actionsHref({ scope: "mine", group: "reply" })).toBe("/actions?scope=mine&group=reply");
    expect(threadQueryFromActions({ scope: "mine", group: "reply" })).toBe("scope=mine&group=reply&from=actions");
    expect(new URLSearchParams(threadQueryFromActions({})).get("from")).toBe("actions");
  });

  it("round-trips: the thread query read back is the view it was built from", () => {
    const view = { scope: "unassigned", campaignId: "0b7e7a7e-1d2f-4c3a-8b4d-5e6f7a8b9c0d", dueBefore: "2026-10-20" };
    const back = Object.fromEntries(new URLSearchParams(threadQueryFromActions(view)));
    expect(actionsViewFrom(back)).toEqual(view);
  });
});
