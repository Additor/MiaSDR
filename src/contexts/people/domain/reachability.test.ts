import { describe, expect, it } from "vitest";
import { reachability, suppressionReasonLabel } from "./reachability";

const since = new Date("2026-10-01T10:00:00Z");
const open = { doNotContact: null, email: "ada@x.test", suppression: null, hasLinkedin: true };

describe("reachability", () => {
  it("leaves both channels open when nothing blocks them", () => {
    expect(reachability(open)).toEqual({
      doNotContact: null,
      email: { state: "open", suppressionReason: null, since: null },
      linkedin: { state: "open" },
    });
  });

  it("blocks email only for a suppressed address, and LinkedIn stays open", () => {
    const reach = reachability({ ...open, suppression: { reason: "bounced", since } });
    expect(reach.email).toEqual({ state: "suppressed", suppressionReason: "bounced", since });
    expect(reach.linkedin.state).toBe("open");
    expect(reach.doNotContact).toBeNull();
  });

  it("carries do not contact with its reason and time next to the channels", () => {
    const reach = reachability({ ...open, doNotContact: { reason: "Asked to stop", since } });
    expect(reach.doNotContact).toEqual({ reason: "Asked to stop", since });
    expect(reach.email.state).toBe("open");
  });

  it("marks a channel without a value as missing", () => {
    expect(reachability({ ...open, email: null, hasLinkedin: false })).toMatchObject({ email: { state: "missing" }, linkedin: { state: "missing" } });
    expect(reachability({ ...open, email: "  " }).email.state).toBe("missing");
    // A suppression entry without an address on the person cannot apply.
    expect(reachability({ ...open, email: null, suppression: { reason: "bounced", since } }).email.state).toBe("missing");
  });
});

describe("suppressionReasonLabel", () => {
  it("labels every stored reason", () => {
    expect(["unsubscribed", "bounced", "manual", "complaint"].map(suppressionReasonLabel)).toEqual(["Unsubscribed", "Bounced", "Added by hand", "Spam complaint"]);
  });

  it("falls back to a readable word for an unknown reason", () => {
    expect(suppressionReasonLabel("do_not_mail")).toBe("Do not mail");
  });
});
