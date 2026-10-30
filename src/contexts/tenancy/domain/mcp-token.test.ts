import { describe, expect, it } from "vitest";
import { bearerToken, isMcpTokenFormat, MCP_TOKEN_PREFIX, mcpTokenHint } from "./mcp-token";

const valid = `${MCP_TOKEN_PREFIX}${"A".repeat(40)}b-_`;

describe("MCP token format", () => {
  it("accepts the prefix and 43 base64url characters only", () => {
    expect(isMcpTokenFormat(valid)).toBe(true);
    expect(isMcpTokenFormat(valid.slice(0, -1))).toBe(false);
    expect(isMcpTokenFormat(`${valid}x`)).toBe(false);
    expect(isMcpTokenFormat(`msdr_xyz_${"A".repeat(43)}`)).toBe(false);
    expect(isMcpTokenFormat(`${MCP_TOKEN_PREFIX}${"A".repeat(42)}=`)).toBe(false);
  });

  it("shows the last four characters as the hint", () => {
    expect(mcpTokenHint(valid)).toBe("Ab-_");
  });

  it("reads a bearer token and nothing else", () => {
    expect(bearerToken(`Bearer ${valid}`)).toBe(valid);
    expect(bearerToken(`bearer  ${valid} `)).toBe(valid);
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken(`Basic ${valid}`)).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
  });
});
