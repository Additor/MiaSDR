import { describe, expect, it } from "vitest";
import { waitingLabel } from "./waiting-label";

describe("waitingLabel", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  it("says Waiting for a reply, Overdue for a follow-up and Failed for a problem", () => {
    expect(waitingLabel({ at: ago(50), basis: "inbound" }, now)).toBe("Waiting 2 d");
    expect(waitingLabel({ at: ago(3), basis: "due" }, now)).toBe("Overdue 3 h");
    expect(waitingLabel({ at: ago(26), basis: "failure" }, now)).toBe("Failed 1 d ago");
  });

  it("reads a failure that just happened as just now and takes ISO strings", () => {
    expect(waitingLabel({ at: now, basis: "failure" }, now)).toBe("Failed just now");
    expect(waitingLabel({ at: "2026-10-16T09:00:00Z", basis: "inbound" }, "2026-10-16T12:00:00Z")).toBe("Waiting 3 h");
  });

  it("prints nothing for a date it cannot read", () => {
    expect(waitingLabel({ at: "nope", basis: "inbound" }, now)).toBe("");
  });
});
