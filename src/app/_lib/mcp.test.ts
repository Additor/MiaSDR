import { afterEach, describe, expect, it, vi } from "vitest";
import { clientNameFrom, mcpActor, runTool, SERVER_ERROR_MESSAGE } from "./mcp";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";

const principal = {
  tokenId: "tok-1",
  tokenName: "Laptop",
  userId: "user-1",
  organizationId: "org-1",
  role: "member",
  scopes: ["mcp:read" as const],
  policyEpoch: 0,
  expiresAt: null,
  send: { replies: false, campaigns: false },
};
const actor = mcpActor(principal, "claude-code");

describe("mcpActor", () => {
  it("acts as the token's owner and marks the agent", () => {
    expect(actor).toEqual({ userId: "user-1", organizationId: "org-1", role: "member", via: { kind: "agent", tokenId: "tok-1", tokenName: "Laptop", clientName: "claude-code" } });
  });
});

describe("clientNameFrom", () => {
  it("reads a 2026-07-28 envelope and ignores anything else", () => {
    expect(clientNameFrom({ "io.modelcontextprotocol/clientInfo": { name: " Cursor ", version: "1" } })).toBe("Cursor");
    expect(clientNameFrom({ "io.modelcontextprotocol/clientInfo": { name: "x".repeat(101) } })).toBeNull();
    expect(clientNameFrom({ "io.modelcontextprotocol/clientInfo": "Cursor" })).toBeNull();
    expect(clientNameFrom(undefined)).toBeNull();
  });
});

describe("runTool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the summary as text and the data as structured content", async () => {
    const seen: unknown[] = [];
    const result = await runTool("echo", actor, async (a) => {
      seen.push(a);
      return { summary: "One conversation.", structured: { count: 1 } };
    });
    expect(seen).toEqual([actor]);
    expect(result).toEqual({ content: [{ type: "text", text: "One conversation." }], structuredContent: { count: 1 } });
  });

  it("answers a classified error with its sentence and the code a JSON route would give", async () => {
    expect(await runTool("t", actor, async () => { throw new NotFoundError("Draft not found"); })).toEqual({
      isError: true,
      content: [{ type: "text", text: "Draft not found" }],
      structuredContent: { error: { code: "not_found", message: "Draft not found" } },
    });
    const conflict = await runTool("t", actor, async () => { throw new ConflictError("Changed.", { code: "stale_version", version: 4 }); });
    expect(conflict.structuredContent).toEqual({ error: { code: "stale_version", message: "Changed.", version: 4 } });
    const invalid = await runTool("t", actor, async () => { throw new ValidationError("Fix the steps.", [{ step: 1, message: "empty" }]); });
    expect(invalid.structuredContent).toEqual({ error: { code: "validation", message: "Fix the steps.", issues: [{ step: 1, message: "empty" }] } });
  });

  it("logs an unknown error and never shows its message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runTool("get_inbox", actor, async () => { throw new Error('relation "secret_table" does not exist'); });
    expect(result).toEqual({ isError: true, content: [{ type: "text", text: SERVER_ERROR_MESSAGE }], structuredContent: { error: { code: "server_error", message: SERVER_ERROR_MESSAGE } } });
    expect(JSON.stringify(result)).not.toContain("secret_table");
    expect(log).toHaveBeenCalledWith("[mcp] get_inbox failed for organization org-1", expect.any(Error));
  });

  it("treats a SyntaxError from the tool's code as a server error, since the SDK already parsed the request", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runTool("search", actor, async () => { throw new SyntaxError("Invalid regular expression: /(/: Unterminated group"); });
    expect(result.structuredContent).toEqual({ error: { code: "server_error", message: SERVER_ERROR_MESSAGE } });
    expect(log).toHaveBeenCalledWith("[mcp] search failed for organization org-1", expect.any(SyntaxError));
  });
});
