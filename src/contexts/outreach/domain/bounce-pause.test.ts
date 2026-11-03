import { describe, expect, it } from "vitest";
import { bouncePauseReason, bouncePercent, bounceResumeLine, bouncesTripPause } from "./bounce-pause";

describe("bounce pause", () => {
  it.each([
    [{ sent: 20, bounced: 1 }, true],
    [{ sent: 40, bounced: 2 }, true],
    [{ sent: 20, bounced: 20 }, true],
    [{ sent: 21, bounced: 1 }, false],
    [{ sent: 41, bounced: 2 }, false],
    [{ sent: 19, bounced: 19 }, false],
    [{ sent: 20, bounced: 0 }, false],
    [{ sent: 0, bounced: 0 }, false],
  ])("%j trips: %s", (count, trips) => {
    expect(bouncesTripPause(count)).toBe(trips);
  });

  it("states the rate with at most one decimal", () => {
    expect(bouncePercent({ sent: 40, bounced: 3 })).toBe(7.5);
    expect(bouncePercent({ sent: 20, bounced: 1 })).toBe(5);
    expect(bouncePercent({ sent: 30, bounced: 2 })).toBe(6.7);
    expect(bouncePercent({ sent: 0, bounced: 0 })).toBe(0);
  });

  it("names the numbers in the reason and the resume line", () => {
    expect(bouncePauseReason({ sent: 40, bounced: 3 })).toBe("MiaSDR paused this campaign because 3 of 40 emails bounced (7.5%) since it last started. A campaign pauses at 5% with at least 20 sends.");
    expect(bounceResumeLine({ sent: 40, bounced: 3 })).toBe("3 of 40 emails bounced (7.5%) since this campaign last started. Resuming sends to the remaining leads and starts a new count, so it pauses again at 5% with at least 20 new sends.");
  });
});
