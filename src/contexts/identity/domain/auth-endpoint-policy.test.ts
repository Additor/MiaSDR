import { describe, expect, it } from "vitest";
import { allowedAuthMutations, authEndpointPath, checkAuthEndpoint } from "./auth-endpoint-policy";

describe("auth endpoint policy", () => {
  it("lets the flows the app uses through", () => {
    for (const path of ["sign-up/email", "sign-in/email", "sign-out", "request-password-reset", "reset-password", "send-verification-email", "organization/accept-invitation", "organization/reject-invitation"]) {
      expect(checkAuthEndpoint("POST", `/api/auth/${path}`).allowed, path).toBe(true);
    }
  });

  it("refuses every organization endpoint that changes state, except accept-invitation and reject-invitation", () => {
    const refused = [
      "create", "update", "delete", "set-active", "leave", "check-slug",
      "invite-member", "cancel-invitation",
      "remove-member", "update-member-role",
      "create-role", "update-role", "delete-role",
      "create-team", "update-team", "remove-team", "set-active-team", "add-team-member", "remove-team-member",
    ];
    for (const path of refused) {
      const verdict = checkAuthEndpoint("POST", `/api/auth/organization/${path}`);
      expect(verdict.allowed, path).toBe(false);
    }
  });

  it("refuses account endpoints the app does not use", () => {
    for (const path of ["change-password", "change-email", "update-user", "delete-user", "revoke-session", "revoke-sessions", "link-social", "set-password"]) {
      expect(checkAuthEndpoint("POST", `/api/auth/${path}`).allowed, path).toBe(false);
    }
  });

  it("matches the method as well as the path", () => {
    expect(checkAuthEndpoint("DELETE", "/api/auth/sign-in/email").allowed).toBe(false);
    expect(checkAuthEndpoint("PUT", "/api/auth/organization/accept-invitation").allowed).toBe(false);
    expect(checkAuthEndpoint("PATCH", "/api/auth/organization/update").allowed).toBe(false);
  });

  it("does not let spelling variants slip past the list", () => {
    for (const path of ["/api/auth/Organization/delete", "/api/auth/organization%2Fdelete", "/api/auth/organization/delete/", "/api/auth//organization/delete", "/api/auth/organization/update-member-role/"]) {
      expect(checkAuthEndpoint("POST", path).allowed, path).toBe(false);
    }
    expect(checkAuthEndpoint("POST", "/api/auth/sign-in/email/").allowed).toBe(true);
  });

  it("serves reads (session, verify-email, OAuth callback)", () => {
    expect(checkAuthEndpoint("GET", "/api/auth/get-session").allowed).toBe(true);
    expect(checkAuthEndpoint("HEAD", "/api/auth/verify-email").allowed).toBe(true);
  });

  it("normalizes the path", () => {
    expect(authEndpointPath("/api/auth/organization/delete/")).toBe("/organization/delete");
    expect(authEndpointPath("/api/auth")).toBe("/");
  });

  it("keeps the allow-list short", () => {
    expect(allowedAuthMutations()).toHaveLength(9);
  });
});
