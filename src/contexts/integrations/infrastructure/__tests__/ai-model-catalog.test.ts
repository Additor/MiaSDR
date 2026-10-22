import { describe, expect, it, vi } from "vitest";
import { aiConnection } from "../../domain/ai-connections";
import { createModelCatalog } from "../ai-model-catalog";

const ANTHROPIC = aiConnection("anthropic")!;

const KEY = "sk-ant-SECRET-key-0123456789";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Anthropic model catalog", () => {
  it("sends the key in a header, never the URL, and follows pages", async () => {
    const stub = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" }))
      .mockResolvedValueOnce(json({ data: [{ id: "claude-b" }, { id: 7 }], has_more: false }));
    const result = await createModelCatalog({ fetch: stub as unknown as typeof fetch }).list(ANTHROPIC, KEY);
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
    const result = await createModelCatalog({ fetch: (async () => json({}, status)) as unknown as typeof fetch }).list(ANTHROPIC, KEY);
    expect(result).toEqual({ ok: false, reason });
  });

  it("treats a network error, a bad body and an empty list as unreachable without leaking the error", async () => {
    const boom = createModelCatalog({ fetch: (async () => { throw new Error(`down ${KEY}`); }) as unknown as typeof fetch });
    expect(await boom.list(ANTHROPIC, KEY)).toEqual({ ok: false, reason: "unreachable" });
    expect(await createModelCatalog({ fetch: (async () => json({ nope: 1 })) as unknown as typeof fetch }).list(ANTHROPIC, KEY)).toEqual({ ok: false, reason: "unreachable" });
    expect(await createModelCatalog({ fetch: (async () => json({ data: [], has_more: false })) as unknown as typeof fetch }).list(ANTHROPIC, KEY)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("rejects a key outside printable ASCII without a call", async () => {
    const stub = vi.fn();
    expect(await createModelCatalog({ fetch: stub as unknown as typeof fetch }).list(ANTHROPIC, "sk-ant-키")).toEqual({ ok: false, reason: "rejected" });
    expect(stub).not.toHaveBeenCalled();
  });
});

describe("gateway model catalogs", () => {
  it("reads Vercel's public list without a key and keeps Anthropic language models only", async () => {
    const stub = vi.fn(async () => json({ data: [{ id: "anthropic/claude-sonnet-5.5", type: "language" }, { id: "openai/gpt-6", type: "language" }, { id: "anthropic/embed", type: "embedding" }] }));
    const result = await createModelCatalog({ fetch: stub as unknown as typeof fetch }).list(aiConnection("vercel-ai-gateway")!, KEY);
    expect(result).toEqual({ ok: true, ids: ["anthropic/claude-sonnet-5.5"] });
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/models");
    expect(JSON.stringify(init.headers)).not.toContain(KEY);
  });

  it("asks OpenRouter for models with structured output support only", async () => {
    const stub = vi.fn(async () => json({ data: [{ id: "openai/gpt-6" }, { id: "anthropic/claude-sonnet-5.5" }] }));
    const result = await createModelCatalog({ fetch: stub as unknown as typeof fetch }).list(aiConnection("openrouter")!, KEY);
    expect(result).toEqual({ ok: true, ids: ["openai/gpt-6", "anthropic/claude-sonnet-5.5"] });
    expect(String((stub.mock.calls[0] as unknown as [string])[0])).toBe("https://openrouter.ai/api/v1/models?supported_parameters=structured_outputs");
  });

  it("treats a failed public list as unreachable, never as a rejected key", async () => {
    const result = await createModelCatalog({ fetch: (async () => json({}, 401)) as unknown as typeof fetch }).list(aiConnection("openrouter")!, KEY);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });
});
