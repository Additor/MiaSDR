import { describe, expect, it } from "vitest";
import { actionToken, actionTokenMatches, readActionToken, stateDigest } from "./action-token";

describe("action tokens", () => {
  const state = { version: 3, counts: { conversations: 2 } };

  it("matches the state it was made from", () => {
    expect(actionTokenMatches(actionToken("delete_deal", "d1", state), "delete_deal", "d1", state)).toBe(true);
  });

  it("stops matching when one item of the state changes", () => {
    const token = actionToken("delete_deal", "d1", state);
    expect(actionTokenMatches(token, "delete_deal", "d1", { ...state, version: 4 })).toBe(false);
    expect(actionTokenMatches(token, "delete_deal", "d1", { ...state, counts: { conversations: 3 } })).toBe(false);
  });

  it("stops matching for another purpose or target", () => {
    const token = actionToken("delete_deal", "d1", state);
    expect(actionTokenMatches(token, "delete_lead", "d1", state)).toBe(false);
    expect(actionTokenMatches(token, "delete_deal", "d2", state)).toBe(false);
  });

  it("gives back the state it carries", () => {
    expect(readActionToken(actionToken("delete_deal", "d1", state), "delete_deal", "d1")).toEqual(state);
  });

  it("reads a broken or foreign token as nothing", () => {
    for (const token of ["", "at1", "at1.", "at1.@@@", "at1.e30", "lt1.start.0.abc", `${actionToken("a", "b", 1)}.x`]) expect(readActionToken(token, "a", "b")).toBeNull();
    expect(readActionToken(actionToken("a", "b", 1), "a", "c")).toBeNull();
  });

  it("digests equal state the same way", () => {
    expect(stateDigest([1, 2])).toBe(stateDigest([1, 2]));
    expect(stateDigest([1, 2])).not.toBe(stateDigest([2, 1]));
  });
});
