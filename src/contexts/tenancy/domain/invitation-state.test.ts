import { describe, expect, it } from "vitest";
import { deriveInvitationState, isInvitationId } from "./invitation-state";

const now = new Date("2026-11-01T12:00:00Z");
const pending = { status: "pending", email: "Ada@Example.com", expiresAt: new Date("2026-11-08T12:00:00Z") };

describe("deriveInvitationState", () => {
  it("is ready for the invited address, whatever its case", () => {
    expect(deriveInvitationState(pending, "ada@example.com", now)).toBe("ready");
    expect(deriveInvitationState(pending, " ADA@example.com ", now)).toBe("ready");
  });

  it("is not-found without a row and for a canceled invitation", () => {
    expect(deriveInvitationState(null, "ada@example.com", now)).toBe("not-found");
    expect(deriveInvitationState({ ...pending, status: "canceled" }, "ada@example.com", now)).toBe("not-found");
    expect(deriveInvitationState({ ...pending, status: "canceled" }, "other@example.com", now)).toBe("not-found");
  });

  it("is expired at the expiry instant and after it", () => {
    expect(deriveInvitationState({ ...pending, expiresAt: now }, "ada@example.com", now)).toBe("expired");
    expect(deriveInvitationState({ ...pending, expiresAt: new Date("2026-10-01T00:00:00Z") }, "ada@example.com", now)).toBe("expired");
  });

  it("is used after accept and declined after reject", () => {
    expect(deriveInvitationState({ ...pending, status: "accepted" }, "ada@example.com", now)).toBe("used");
    expect(deriveInvitationState({ ...pending, status: "rejected" }, "ada@example.com", now)).toBe("declined");
  });

  it("is wrong-account for any other address, in every status", () => {
    for (const status of ["pending", "accepted", "rejected"]) {
      expect(deriveInvitationState({ ...pending, status }, "eve@example.com", now), status).toBe("wrong-account");
    }
    expect(deriveInvitationState({ ...pending, expiresAt: new Date("2026-10-01T00:00:00Z") }, "eve@example.com", now)).toBe("wrong-account");
  });

  it("is anonymous for a visitor without a session, unless the row is missing", () => {
    expect(deriveInvitationState(pending, null, now)).toBe("anonymous");
    expect(deriveInvitationState({ ...pending, status: "accepted" }, null, now)).toBe("anonymous");
    expect(deriveInvitationState(null, null, now)).toBe("not-found");
  });
});

describe("isInvitationId", () => {
  it("accepts uuids and refuses anything else", () => {
    expect(isInvitationId("0b7e2c1a-5d3f-4a8e-9c61-2f4d8a7b1e90")).toBe(true);
    for (const bad of ["", "x", "not-a-uuid", "0b7e2c1a5d3f4a8e9c612f4d8a7b1e90", "../etc", "0b7e2c1a-5d3f-4a8e-9c61-2f4d8a7b1e9g"]) expect(isInvitationId(bad), bad).toBe(false);
  });
});
