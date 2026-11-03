import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_SETTINGS, MAX_AGENT_ENROLL_CAP, MAX_AGENT_IRREVERSIBLE, MAX_AGENT_REPLY_CAP, MAX_AGENT_SEARCH_LEADS, MAX_AGENT_SPEND_CENTS, mcpSettingsProblem, readMcpSettings } from "./mcp-settings";

describe("MCP settings", () => {
  it("starts with MCP and agent sending off", () => {
    expect(readMcpSettings(undefined)).toEqual(DEFAULT_MCP_SETTINGS);
    expect(DEFAULT_MCP_SETTINGS).toMatchObject({ enabled: false, agentSendMode: "off", agentSendEpoch: 0 });
  });

  it("reads stored values", () => {
    const stored = { enabled: true, memberWriteTokens: false, agentSendMode: "replies", agentSendEpoch: 3, agentReplyCaps: { org: 10, user: 5, mailbox: 0 }, agentEnrollCap: 0 };
    expect(readMcpSettings(stored)).toEqual({ ...DEFAULT_MCP_SETTINGS, ...stored });
  });

  it("replaces each malformed key with its default and keeps the others", () => {
    const settings = readMcpSettings({ enabled: "yes", agentSendMode: "always", agentSendEpoch: -1, agentReplyCaps: { org: 20, user: 1.5, mailbox: MAX_AGENT_REPLY_CAP + 1 }, agentEnrollCap: MAX_AGENT_ENROLL_CAP + 1, memberWriteTokens: false });
    expect(settings).toEqual({ ...DEFAULT_MCP_SETTINGS, memberWriteTokens: false, agentReplyCaps: { org: 20, user: 50, mailbox: 30 } });
    expect(readMcpSettings({ agentReplyCaps: "100" }).agentReplyCaps).toEqual(DEFAULT_MCP_SETTINGS.agentReplyCaps);
  });

  it("starts with spending and irreversible actions off, and reads their limits", () => {
    expect(DEFAULT_MCP_SETTINGS).toMatchObject({ agentSpendCentsPerDay: 0, agentSearchLeadsPerDay: 0, agentIrreversiblePerDay: 0, agentSpendEpoch: 0, agentIrreversibleEpoch: 0 });
    const stored = { agentSpendCentsPerDay: 500, agentSearchLeadsPerDay: 100, agentIrreversiblePerDay: 5, agentSpendEpoch: 2, agentIrreversibleEpoch: 3 };
    expect(readMcpSettings(stored)).toMatchObject(stored);
    expect(readMcpSettings({ agentSpendCentsPerDay: MAX_AGENT_SPEND_CENTS + 1, agentSearchLeadsPerDay: 1.5, agentIrreversiblePerDay: -1 })).toMatchObject({ agentSpendCentsPerDay: 0, agentSearchLeadsPerDay: 0, agentIrreversiblePerDay: 0 });
  });

  it("turns a limit off when the epoch that guards it is malformed, without touching the other", () => {
    expect(readMcpSettings({ agentSpendCentsPerDay: 500, agentSearchLeadsPerDay: 100, agentIrreversiblePerDay: 5, agentSpendEpoch: "1" })).toMatchObject({ agentSpendCentsPerDay: 0, agentSearchLeadsPerDay: 0, agentIrreversiblePerDay: 5 });
    expect(readMcpSettings({ agentSpendCentsPerDay: 500, agentIrreversiblePerDay: 5, agentIrreversibleEpoch: -1 })).toMatchObject({ agentSpendCentsPerDay: 500, agentIrreversiblePerDay: 0 });
  });

  it("refuses limits out of range and epochs in a patch", () => {
    expect(mcpSettingsProblem({ agentSpendCentsPerDay: MAX_AGENT_SPEND_CENTS, agentSearchLeadsPerDay: MAX_AGENT_SEARCH_LEADS, agentIrreversiblePerDay: MAX_AGENT_IRREVERSIBLE })).toBeNull();
    expect(mcpSettingsProblem({ agentSpendCentsPerDay: MAX_AGENT_SPEND_CENTS + 1 })).toMatch(/whole number/);
    expect(mcpSettingsProblem({ agentSearchLeadsPerDay: -1 })).toMatch(/whole number/);
    expect(mcpSettingsProblem({ agentIrreversiblePerDay: 0.5 })).toMatch(/whole number/);
    expect(mcpSettingsProblem({ agentSpendEpoch: 9 })).toMatch(/not an MCP setting/);
    expect(mcpSettingsProblem({ agentIrreversibleEpoch: 9 })).toMatch(/not an MCP setting/);
  });

  it("turns agent sending off when the stored epoch is malformed", () => {
    for (const agentSendEpoch of ["3", -1, 1.5, null]) {
      expect(readMcpSettings({ agentSendMode: "replies_and_campaigns", agentSendEpoch }).agentSendMode, String(agentSendEpoch)).toBe("off");
    }
    expect(readMcpSettings({ agentSendMode: "replies" }).agentSendMode).toBe("replies");
  });

  it("accepts a valid patch", () => {
    expect(mcpSettingsProblem({})).toBeNull();
    expect(mcpSettingsProblem({ enabled: true, agentSendMode: "replies_and_campaigns", agentReplyCaps: { org: 0, user: 0, mailbox: 0 }, agentEnrollCap: MAX_AGENT_ENROLL_CAP })).toBeNull();
  });

  it("refuses a bad value, an unknown key and the epoch", () => {
    expect(mcpSettingsProblem({ enabled: 1 })).toMatch(/true or false/);
    expect(mcpSettingsProblem({ agentSendMode: "always" })).toMatch(/off, replies, replies_and_campaigns/);
    expect(mcpSettingsProblem({ agentReplyCaps: { org: 1, user: 1 } })).toMatch(/whole number/);
    expect(mcpSettingsProblem({ agentReplyCaps: null })).toMatch(/missing/);
    expect(mcpSettingsProblem({ agentEnrollCap: -1 })).toMatch(/whole number/);
    expect(mcpSettingsProblem({ agentSendEpoch: 4 })).toMatch(/not an MCP setting/);
    expect(mcpSettingsProblem({ color: "red" })).toMatch(/not an MCP setting/);
  });
});
