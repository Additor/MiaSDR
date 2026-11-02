import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_SETTINGS, type McpSettings } from "./mcp-settings";
import { agentIrreversiblePolicy, agentSendPolicy, agentSpendPolicy, hasScope, readScopes, tokenAccess, tokenActions, tokenScopesProblem, usableScopes, type ActionPolicyToken, type PolicyToken } from "./mcp-policy";

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

describe("scopes a token may use now", () => {
  const all = ["mcp:read", "mcp:write", "mcp:send"];

  it("keeps the stored scopes while the person may still create them", () => {
    expect(usableScopes({ role: "member", settings: on, scopes: all })).toEqual(all);
    expect(usableScopes({ role: "admin", settings: { ...on, memberWriteTokens: false }, scopes: all })).toEqual(all);
  });

  it("drops write and send from a member once member write tokens are off", () => {
    expect(usableScopes({ role: "member", settings: { ...on, memberWriteTokens: false }, scopes: all })).toEqual(["mcp:read"]);
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

describe("what a token does now, for the token list", () => {
  const access = (patch: { role?: string | null; settings?: Partial<McpSettings>; token?: Partial<PolicyToken> } = {}) =>
    tokenAccess({ role: patch.role === undefined ? "owner" : patch.role, installSendEnabled: true, settings: { ...on, ...patch.settings }, token: { ...sendToken, ...patch.token }, now });

  it("sends while the policy allows it", () => {
    expect(access()).toEqual({ access: "send", sendRetired: false });
  });
  it("marks a send token retired once sending went off or the policy moved on", () => {
    expect(access({ settings: { agentSendMode: "off" } })).toEqual({ access: "write", sendRetired: true });
    expect(access({ settings: { agentSendEpoch: 3 } })).toEqual({ access: "write", sendRetired: true });
  });
  it("drops write and send from a member when member write tokens are off, and everything from someone who left", () => {
    expect(access({ role: "member", settings: { memberWriteTokens: false } })).toEqual({ access: "read", sendRetired: false });
    expect(access({ role: null })).toEqual({ access: "read", sendRetired: false });
    expect(access({ token: { scopes: ["mcp:read", "mcp:write"] } })).toEqual({ access: "write", sendRetired: false });
  });
});

describe("scopes that spend or cannot be undone", () => {
  const limits: McpSettings = { ...on, agentSpendCentsPerDay: 500, agentSearchLeadsPerDay: 100, agentIrreversiblePerDay: 5 };
  const read = "mcp:read";
  const write = "mcp:write";

  it("lets only owners and admins create them, whatever the member write setting says", () => {
    for (const memberWriteTokens of [true, false]) {
      for (const scope of ["mcp:spend", "mcp:irreversible"]) {
        const settings = { ...limits, memberWriteTokens };
        expect(tokenScopesProblem({ role: "owner", settings, scopes: [read, write, scope] })).toBeNull();
        expect(tokenScopesProblem({ role: "admin", settings, scopes: [read, write, scope] })).toBeNull();
        expect(tokenScopesProblem({ role: "member", settings, scopes: [read, write, scope] })).toMatch(/owners and admins/i);
      }
    }
  });

  it("needs write, and each stands alone", () => {
    expect(tokenScopesProblem({ role: "owner", settings: limits, scopes: [read, "mcp:spend"] })).toMatch(/must also write/);
    expect(tokenScopesProblem({ role: "owner", settings: limits, scopes: [read, "mcp:irreversible"] })).toMatch(/must also write/);
    expect(tokenScopesProblem({ role: "owner", settings: { ...limits, agentSendMode: "off" }, scopes: [read, write, "mcp:spend", "mcp:irreversible"] })).toBeNull();
  });

  it("refuses a token while its limit is 0", () => {
    const off = { ...limits, agentSpendCentsPerDay: 0, agentSearchLeadsPerDay: 0 };
    expect(tokenScopesProblem({ role: "owner", settings: off, scopes: [read, write, "mcp:spend"] })).toMatch(/spending is off/);
    expect(tokenScopesProblem({ role: "owner", settings: { ...off, agentSearchLeadsPerDay: 1 }, scopes: [read, write, "mcp:spend"] })).toBeNull();
    expect(tokenScopesProblem({ role: "owner", settings: { ...limits, agentIrreversiblePerDay: 0 }, scopes: [read, write, "mcp:irreversible"] })).toMatch(/off in this organization/);
  });

  it("drops them from a member's usable scopes, even one who keeps write", () => {
    const all = [read, write, "mcp:send", "mcp:spend", "mcp:irreversible"];
    expect(usableScopes({ role: "member", settings: limits, scopes: all })).toEqual([read, write, "mcp:send"]);
    expect(usableScopes({ role: "member", settings: { ...limits, memberWriteTokens: false }, scopes: all })).toEqual([read]);
    expect(usableScopes({ role: "admin", settings: { ...limits, memberWriteTokens: false }, scopes: all })).toEqual(all);
  });
});

describe("agent spend and irreversible policies", () => {
  const settings: McpSettings = { ...on, agentSpendCentsPerDay: 500, agentSearchLeadsPerDay: 100, agentSpendEpoch: 2, agentIrreversiblePerDay: 5, agentIrreversibleEpoch: 4 };
  const token: ActionPolicyToken = { scopes: ["mcp:read", "mcp:write", "mcp:spend", "mcp:irreversible"], spendEpoch: 2, irreversibleEpoch: 4, revokedAt: null, expiresAt: null };
  const spend = (patch: { settings?: Partial<McpSettings>; token?: Partial<ActionPolicyToken>; installEnabled?: boolean } = {}) =>
    agentSpendPolicy({ installEnabled: patch.installEnabled ?? true, settings: { ...settings, ...patch.settings }, token: { ...token, ...patch.token }, now });
  const irreversible = (patch: { settings?: Partial<McpSettings>; token?: Partial<ActionPolicyToken>; installEnabled?: boolean } = {}) =>
    agentIrreversiblePolicy({ installEnabled: patch.installEnabled ?? true, settings: { ...settings, ...patch.settings }, token: { ...token, ...patch.token }, now });

  it("allows both with a live token, the scope and the limits", () => {
    expect(spend()).toEqual({ enrichment: true, search: true, refusal: null });
    expect(irreversible()).toBeNull();
  });

  it("keeps enrichment and search apart when one limit is 0", () => {
    expect(spend({ settings: { agentSearchLeadsPerDay: 0 } })).toEqual({ enrichment: true, search: false, refusal: null });
    expect(spend({ settings: { agentSpendCentsPerDay: 0 } })).toEqual({ enrichment: false, search: true, refusal: null });
  });

  it("names the first thing to fix", () => {
    expect(spend({ installEnabled: false, token: { revokedAt: now } }).refusal).toBe("install_off");
    expect(spend({ token: { revokedAt: now } }).refusal).toBe("token_revoked");
    expect(spend({ token: { expiresAt: now } }).refusal).toBe("token_expired");
    expect(spend({ token: { scopes: ["mcp:read", "mcp:write"] } }).refusal).toBe("no_scope");
    expect(spend({ settings: { agentSpendCentsPerDay: 0, agentSearchLeadsPerDay: 0 } }).refusal).toBe("limit_off");
    expect(spend({ token: { spendEpoch: 1 } }).refusal).toBe("epoch_changed");
    expect(irreversible({ installEnabled: false })).toBe("install_off");
    expect(irreversible({ token: { scopes: ["mcp:read", "mcp:write", "mcp:spend"] } })).toBe("no_scope");
    expect(irreversible({ settings: { agentIrreversiblePerDay: 0 } })).toBe("limit_off");
    expect(irreversible({ token: { irreversibleEpoch: 3 } })).toBe("epoch_changed");
  });

  it("keeps each epoch to its own policy", () => {
    expect(spend({ token: { irreversibleEpoch: 3 } }).refusal).toBeNull();
    expect(irreversible({ token: { spendEpoch: 1 } })).toBeNull();
  });

  it("shows what a token does now and when it stopped for good", () => {
    const actions = (patch: { role?: string | null; settings?: Partial<McpSettings>; token?: Partial<ActionPolicyToken> } = {}) =>
      tokenActions({ role: patch.role === undefined ? "owner" : patch.role, installSpendEnabled: true, installIrreversibleEnabled: true, settings: { ...settings, ...patch.settings }, token: { ...token, ...patch.token }, now });
    expect(actions()).toEqual({ spends: true, spendRetired: false, irreversible: true, irreversibleRetired: false });
    expect(actions({ role: "member" })).toEqual({ spends: false, spendRetired: false, irreversible: false, irreversibleRetired: false });
    expect(actions({ token: { spendEpoch: 1, irreversibleEpoch: 3 } })).toEqual({ spends: false, spendRetired: true, irreversible: false, irreversibleRetired: true });
    expect(actions({ token: { scopes: ["mcp:read"], spendEpoch: 1 } }).spendRetired).toBe(false);
  });
});
