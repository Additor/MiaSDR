import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_SETTINGS, type McpSettings } from "../domain/mcp-settings";
import { consentChoices } from "./mcp-tokens";

const on: McpSettings = { ...DEFAULT_MCP_SETTINGS, enabled: true, agentSendMode: "replies" };

describe("what a person may choose for an app", () => {
  it("offers only what the app asked for", () => {
    expect(consentChoices(on, "admin", true, "mcp:read offline_access")).toEqual(["read"]);
    expect(consentChoices(on, "admin", true, "mcp:read mcp:write mcp:send")).toEqual(["read", "write", "send"]);
  });

  it("gives an app that names no MCP scope reading", () => {
    expect(consentChoices(on, "admin", true, "")).toEqual(["read"]);
    expect(consentChoices(on, "admin", true, "offline_access")).toEqual(["read"]);
  });

  it("drops what this person cannot grant", () => {
    expect(consentChoices(on, "admin", false, "mcp:read mcp:send")).toEqual(["read"]);
    expect(consentChoices({ ...on, agentSendMode: "off" }, "admin", true, "mcp:read mcp:send")).toEqual(["read"]);
    expect(consentChoices({ ...on, memberWriteTokens: false }, "member", true, "mcp:read mcp:write")).toEqual(["read"]);
  });
});
