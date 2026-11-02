import { describe, expect, it } from "vitest";
import { launchToken, launchTokenMatches } from "./agent-campaign";

describe("launch token", () => {
  it("does not carry over to another campaign with the same steps", () => {
    const state = { id: "a", channel: "email" as const, status: "draft", steps: [], senders: [] };
    const token = launchToken("start", state, 0);
    expect(launchTokenMatches(token, "start", state, 0)).toBe(true);
    expect(launchTokenMatches(token, "start", { ...state, id: "b" }, 0)).toBe(false);
  });
});
