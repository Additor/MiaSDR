import { describe, expect, it, vi } from "vitest";
import { createModelCatalog } from "../anthropic-model-catalog";

const KEY = "sk-ant-SECRET-key-0123456789";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Anthropic model catalog", () => {
  it("sends the key in a header, never the URL, and follows pages", async () => {
    const stub = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" }))
      .mockResolvedValueOnce(json({ data: [{ id: "claude-b" }, { id: 7 }], has_more: false }));
    const result = await createModelCatalog({ fetch: stub as unknown as typeof fetch }).list(KEY);
    expect(result).toEqual({ ok: true, ids: ["claude-a", "claude-b"] });
    const urls = stub.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(urls[1]).toBe("https://api.anthropic.com/v1/models?limit=1000&after_id=claude-a");
    for (const [url, init] of stub.mock.calls as Array<[URL, RequestInit]>) {
      expect(String(url)).not.toContain(KEY);
      expect(init.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
      expect(init.method).toBe("GET");
    }
  });

  it.each([
    [401, "rejected"],
    [403, "rejected"],
    [429, "unreachable"],
    [500, "unreachable"],
  ] as const)("maps status %s to %s", async (status, reason) => {
    const result = await createModelCatalog({ fetch: (async () => json({}, status)) as unknown as typeof fetch }).list(KEY);
    expect(result).toEqual({ ok: false, reason });
  });

  it("treats a network error, a bad body and an empty list as unreachable without leaking the error", async () => {
    const boom = createModelCatalog({ fetch: (async () => { throw new Error(`down ${KEY}`); }) as unknown as typeof fetch });
    expect(await boom.list(KEY)).toEqual({ ok: false, reason: "unreachable" });
    expect(await createModelCatalog({ fetch: (async () => json({ nope: 1 })) as unknown as typeof fetch }).list(KEY)).toEqual({ ok: false, reason: "unreachable" });
    expect(await createModelCatalog({ fetch: (async () => json({ data: [], has_more: false })) as unknown as typeof fetch }).list(KEY)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("rejects a key outside printable ASCII without a call", async () => {
    const stub = vi.fn();
    expect(await createModelCatalog({ fetch: stub as unknown as typeof fetch }).list("sk-ant-키")).toEqual({ ok: false, reason: "rejected" });
    expect(stub).not.toHaveBeenCalled();
  });
});
