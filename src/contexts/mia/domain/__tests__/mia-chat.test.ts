import { describe, expect, it } from "vitest";
import { isAppLink, shownStatus, threadTitle, TURN_STALE_MS } from "../mia-chat";

const ID = "6f1c2a1e-1f0b-4a5e-9d3c-2b7a8c9d0e1f";

describe("isAppLink", () => {
  it("opens the app's own record pages and Brain", () => {
    for (const href of [`/leads/${ID}`, `/crm/contacts/${ID}`, `/crm/companies/${ID}`, `/inbox/${ID}`, `/brain/${ID}`, "/brain"]) expect(isAppLink(href)).toBe(true);
  });

  it("opens nothing that could carry data out of the app", () => {
    for (const href of [
      "https://evil.test/?q=secret",
      "//evil.test/leads",
      `/leads/${ID}?leak=1`,
      `/leads/${ID}#x`,
      "/leads/not-a-uuid",
      "/settings/integrations",
      "javascript:alert(1)",
      `/leads/${ID}/../../api/leads`,
      "data:text/html,hi",
    ])
      expect(isAppLink(href)).toBe(false);
  });
});

describe("threadTitle", () => {
  it("takes the first line of the question, shortened", () => {
    expect(threadTitle("  Who replied?\nAnd when?")).toBe("Who replied?");
    expect(threadTitle("x".repeat(100))).toHaveLength(60);
  });
});

describe("shownStatus", () => {
  it("shows an answer whose turn stopped saving as interrupted", () => {
    const now = new Date();
    expect(shownStatus({ status: "streaming", updatedAt: new Date(now.getTime() - 1000) }, now)).toBe("streaming");
    expect(shownStatus({ status: "streaming", updatedAt: new Date(now.getTime() - TURN_STALE_MS - 1) }, now)).toBe("interrupted");
    expect(shownStatus({ status: "complete", updatedAt: new Date(0) }, now)).toBe("complete");
  });
});
