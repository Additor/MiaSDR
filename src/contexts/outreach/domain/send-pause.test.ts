import { describe, expect, it } from "vitest";
import { readSendPause } from "./send-pause";

describe("readSendPause", () => {
  it("reads a stored pause", () => {
    expect(readSendPause({ timeZone: "UTC", sendingPaused: { at: "2026-10-22T01:00:00.000Z", byName: "Ada" } })).toEqual({ at: "2026-10-22T01:00:00.000Z", byName: "Ada" });
  });

  it("treats no settings, a cleared pause and a malformed value as running", () => {
    expect(readSendPause(null)).toBeNull();
    expect(readSendPause({ sendingPaused: null })).toBeNull();
    expect(readSendPause({ sendingPaused: true })).toBeNull();
    expect(readSendPause({ sendingPaused: { byName: "Ada" } })).toBeNull();
  });
});
