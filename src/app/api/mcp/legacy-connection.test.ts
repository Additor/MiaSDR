import { describe, expect, it } from "vitest";
import { connectionClient, connectionId, initializingClient, withConnectionId } from "./legacy-connection";

describe("a 2025-11-25 connection's client name", () => {
  it("comes back from the id, for any name a client can have, in visible ASCII", () => {
    for (const name of ["claude-code", "Claude Code", "클로드.코드"]) {
      const id = connectionId(name);
      expect(id).toMatch(/^[\x21-\x7e]+$/);
      expect(connectionClient(id)).toBe(name);
    }
    expect(connectionId("a")).not.toBe(connectionId("a"));
  });

  it("is null for an id this endpoint did not write, or a name the checks refuse", () => {
    for (const id of [null, "", "abc", "abc.", ".", `x.${Buffer.from("n".repeat(101)).toString("base64url")}`, `x.${Buffer.from("   ").toString("base64url")}`]) {
      expect(connectionClient(id)).toBeNull();
    }
  });

  it("is read from an initialize request only", () => {
    const body = (method: string, clientInfo: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { clientInfo } });
    expect(initializingClient(body("initialize", { name: "claude-code", version: "2" }))).toBe("claude-code");
    expect(initializingClient(body("tools/list", { name: "claude-code" }))).toBeNull();
    expect(initializingClient(body("initialize", { name: "" }))).toBeNull();
    expect(initializingClient(body("initialize", "claude-code"))).toBeNull();
    expect(initializingClient("not json")).toBeNull();
    expect(initializingClient("null")).toBeNull();
  });

  it("travels on a copy of the answer", async () => {
    const answer = withConnectionId(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }), "claude-code");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/json");
    expect(connectionClient(answer.headers.get("mcp-session-id"))).toBe("claude-code");
    expect(await answer.text()).toBe("{}");
  });
});
