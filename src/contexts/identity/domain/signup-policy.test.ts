import { describe, expect, it } from "vitest";
import { mayCreateAccount, mayCreateOrganization, publicSignupAvailable } from "./signup-policy";

describe("mayCreateAccount", () => {
  it("allows anyone on open instances", () => {
    expect(mayCreateAccount({ mode: "open", hasAnyUser: true, hasPendingInvitation: false })).toBe(true);
  });
  it("refuses every sign-up on an empty instance, because /setup creates the first account", () => {
    expect(mayCreateAccount({ mode: "invite-only", hasAnyUser: false, hasPendingInvitation: false })).toBe(false);
    expect(mayCreateAccount({ mode: "invite-only", hasAnyUser: false, hasPendingInvitation: true })).toBe(false);
    expect(mayCreateAccount({ mode: "open", hasAnyUser: false, hasPendingInvitation: false })).toBe(false);
  });
  it("requires an invitation after the first user", () => {
    expect(mayCreateAccount({ mode: "invite-only", hasAnyUser: true, hasPendingInvitation: false })).toBe(false);
    expect(mayCreateAccount({ mode: "invite-only", hasAnyUser: true, hasPendingInvitation: true })).toBe(true);
  });
});

describe("publicSignupAvailable", () => {
  it("is offered on open instances that already have a user", () => {
    expect(publicSignupAvailable({ mode: "open", hasAnyUser: true })).toBe(true);
    expect(publicSignupAvailable({ mode: "open", hasAnyUser: false })).toBe(false);
    expect(publicSignupAvailable({ mode: "invite-only", hasAnyUser: false })).toBe(false);
    expect(publicSignupAvailable({ mode: "invite-only", hasAnyUser: true })).toBe(false);
  });
});

describe("mayCreateOrganization", () => {
  const base = { mode: "invite-only" as const, organizationExists: true };
  it("limits invite-only creation to owners and admins of the first organization", () => {
    expect(mayCreateOrganization({ ...base, rolesInFirstOrganization: "member" })).toBe(false);
    expect(mayCreateOrganization({ ...base, rolesInFirstOrganization: "admin" })).toBe(true);
    expect(mayCreateOrganization({ ...base, rolesInFirstOrganization: "member,owner" })).toBe(true);
    expect(mayCreateOrganization({ ...base, rolesInFirstOrganization: null })).toBe(false);
  });
  it("allows creation when no organization exists", () => {
    expect(mayCreateOrganization({ mode: "invite-only", organizationExists: false, rolesInFirstOrganization: null })).toBe(true);
  });
});
