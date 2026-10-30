import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_SETTINGS, type McpSettings } from "./mcp-settings";
import { agentSendPolicy, hasScope, readScopes, tokenScopesProblem, type PolicyToken } from "./mcp-policy";

const now = new Date("2026-10-30T12:00:00Z");
const on: McpSettings = { ...DEFAULT_MCP_SETTINGS, enabled: true, agentSendMode: "replies", agentSendEpoch: 2 };
const sendToken: PolicyToken = { scopes: ["mcp:read", "mcp:write", "mcp:send"], policyEpoch: 2, revokedAt: null, expiresAt: new Date("2027-01-01T00:00:00Z") };
const policy = (patch: { settings?: Partial<McpSettings>; token?: Partial<PolicyToken>; installSendEnabled?: boolean } = {}) =>
  agentSendPolicy({ installSendEnabled: patch.installSendEnabled ?? true, settings: { ...on, ...patch.settings }, token: { ...sendToken, ...patch.token }, now });

describe("MCP scopes", () => {
  it("drops unknown words and checks membership", () => {
    expect(readScopes(["mcp:send", "admin", "mcp:read"])).toEqual(["mcp:read", "mcp:send"]);
    expect(hasScope(["mcp:read"], "mcp:write")).toBe(false);
    expect(hasScope(["mcp:read", "mcp:write"], "mcp:write")).toBe(true);
  });
});

describe("token scopes a person may create", () => {
  it("needs read, and send needs write", () => {
    expect(tokenScopesProblem({ role: "member", settings: on, scopes: ["mcp:read"] })).toBeNull();
    expect(tokenScopesProblem({ role: "member", settings: on, scopes: [] })).toMatch(/read scope/);
    expect(tokenScopesProblem({ role: "member", settings: on, scopes: ["mcp:write"] })).toMatch(/read scope/);
    expect(tokenScopesProblem({ role: "admin", settings: on, scopes: ["mcp:read", "mcp:send"] })).toMatch(/must also write/);
    expect(tokenScopesProblem({ role: "member", settings: on, scopes: ["mcp:read", "mcp:root"] })).toMatch(/Unknown scope: mcp:root/);
  });

  it("lets members write unless the organization turned that off, and admins always", () => {
    const closed = { ...on, memberWriteTokens: false };
    expect(tokenScopesProblem({ role: "member", settings: on, scopes: ["mcp:read", "mcp:write"] })).toBeNull();
    expect(tokenScopesProblem({ role: "member", settings: closed, scopes: ["mcp:read", "mcp:write"] })).toMatch(/Only owners and admins/);
    expect(tokenScopesProblem({ role: "member,admin", settings: closed, scopes: ["mcp:read", "mcp:write"] })).toBeNull();
  });

  it("lets anyone who may write create a send token while agent sending is on", () => {
    const all = ["mcp:read", "mcp:write", "mcp:send"];
    expect(tokenScopesProblem({ role: "member", settings: on, scopes: all })).toBeNull();
    expect(tokenScopesProblem({ role: "owner", settings: { ...on, agentSendMode: "off" }, scopes: all })).toMatch(/Agent sending is off/);
  });
});

describe("agent send policy", () => {
  it("allows replies in replies mode and campaigns only in replies_and_campaigns", () => {
    expect(policy()).toEqual({ replies: true, campaigns: false, refusal: null });
    expect(policy({ settings: { agentSendMode: "replies_and_campaigns" } })).toEqual({ replies: true, campaigns: true, refusal: null });
  });

  it("refuses for the first thing to fix, in order", () => {
    expect(policy({ installSendEnabled: false, token: { revokedAt: now } }).refusal).toBe("install_off");
    expect(policy({ token: { revokedAt: now, expiresAt: now } }).refusal).toBe("token_revoked");
    expect(policy({ token: { expiresAt: now } }).refusal).toBe("token_expired");
    expect(policy({ token: { scopes: ["mcp:read", "mcp:write"] } }).refusal).toBe("no_send_scope");
    expect(policy({ settings: { agentSendMode: "off" } }).refusal).toBe("mode_off");
    expect(policy({ token: { policyEpoch: 1 } })).toEqual({ replies: false, campaigns: false, refusal: "epoch_changed" });
  });

  it("does not revive a send token after the mode went off and back on", () => {
    // Mode off raised the epoch from 2 to 3; turning it back on keeps 3.
    expect(policy({ settings: { agentSendMode: "replies", agentSendEpoch: 3 } }).refusal).toBe("epoch_changed");
  });

  it("treats a token with no expiry as not expired", () => {
    expect(policy({ token: { expiresAt: null } }).replies).toBe(true);
  });
});
