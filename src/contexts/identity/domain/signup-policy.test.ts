import { describe, expect, it } from "vitest";
import { adminsTheFirstOrganization, mayCreateAccount } from "./signup-policy";

describe("mayCreateAccount", () => {
  it("refuses every sign-up on an empty instance, because /setup creates the first account", () => {
    expect(mayCreateAccount({ hasAnyUser: false, hasPendingInvitation: false })).toBe(false);
    expect(mayCreateAccount({ hasAnyUser: false, hasPendingInvitation: true })).toBe(false);
  });
  it("requires an invitation after the first user", () => {
    expect(mayCreateAccount({ hasAnyUser: true, hasPendingInvitation: false })).toBe(false);
    expect(mayCreateAccount({ hasAnyUser: true, hasPendingInvitation: true })).toBe(true);
  });
});

describe("adminsTheFirstOrganization", () => {
  it("counts owners and admins, and nobody else", () => {
    expect(adminsTheFirstOrganization("member")).toBe(false);
    expect(adminsTheFirstOrganization("admin")).toBe(true);
    expect(adminsTheFirstOrganization("member,owner")).toBe(true);
    expect(adminsTheFirstOrganization(null)).toBe(false);
  });
});
