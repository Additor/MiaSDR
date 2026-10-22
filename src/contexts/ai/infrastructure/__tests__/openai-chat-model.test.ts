import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest } from "../../domain/generation";
import { OpenAiChatModel } from "../openai-chat-model";

const schema = { type: "object", properties: { k: { type: "string" } }, required: ["k"], additionalProperties: false };
const request: GenerateRequest = {
  task: "grid.answer",
  system: [{ text: "STABLE RULES", cacheable: true }],
  messages: [{ role: "user", content: "SECRET-BODY" }],
  output: { kind: "json", name: "row_fields", schema },
  maxTokens: 4000,
};

const ok = (content: string, extra: object = {}, usage: object = { prompt_tokens: 12, completion_tokens: 4, cost: 0.0021, prompt_tokens_details: { cached_tokens: 8 } }) =>
  new Response(JSON.stringify({ id: "gen-1", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage, ...extra }), { status: 200 });
const fail = (status: number, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error: { code: status, message: "boom" } }), { status, headers });

function model(fetchMock: unknown, extra: Partial<ConstructorParameters<typeof OpenAiChatModel>[0]> = {}) {
  const sleep = vi.fn(async () => undefined);
  return { m: new OpenAiChatModel({ apiKey: "sk-or-123", model: "openai/gpt-6", baseUrl: "https://openrouter.ai/api/v1", fetch: fetchMock as typeof fetch, sleep, ...extra }), sleep };
}

const sent = (fetchMock: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
};

describe("OpenAiChatModel (OpenRouter)", () => {
  it("posts Chat Completions with a strict json_schema and routes only to endpoints that support it", async () => {
    const fetchMock = vi.fn(async () => ok('{"k":"v"}'));
    const result = await model(fetchMock).m.generate(request);
    expect(result).toEqual({ text: '{"k":"v"}', stop: "end", usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 8, cacheWriteTokens: 0, costUsd: 0.0021 }, requestId: "gen-1" });
    const { url, headers, body } = sent(fetchMock);
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer sk-or-123");
    expect(body).toMatchObject({ model: "openai/gpt-6", max_tokens: 4000, provider: { require_parameters: true } });
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "row_fields", strict: true, schema } });
    expect(body.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "STABLE RULES" }] });
    expect(body.messages[1]).toEqual({ role: "user", content: "SECRET-BODY" });
  });

  it("marks stable system text for caching on Anthropic models only", async () => {
    const fetchMock = vi.fn(async () => ok("{}"));
    await model(fetchMock, { model: "anthropic/claude-sonnet-5.5" }).m.generate(request);
    expect(sent(fetchMock).body.messages[0].content[0]).toEqual({ type: "text", text: "STABLE RULES", cache_control: { type: "ephemeral" } });
  });

  it("maps finish reasons, and treats a provider error inside a 200 as transient", async () => {
    expect((await model(vi.fn(async () => ok("{", { choices: [{ finish_reason: "length", message: { content: "{" } }] }))).m.generate(request)).stop).toBe("max_tokens");
    expect((await model(vi.fn(async () => ok("", { choices: [{ finish_reason: "content_filter", message: { content: "" } }] }))).m.generate(request)).stop).toBe("refusal");
    await expect(model(vi.fn(async () => ok("", { choices: [{ finish_reason: "error", message: { content: "" } }] }))).m.generate(request)).rejects.toMatchObject({ kind: "transient" });
    await expect(model(vi.fn(async () => ok("", { error: { message: "upstream down" }, choices: [] }))).m.generate(request)).rejects.toMatchObject({ kind: "transient" });
  });

  it("retries 429 and 5xx, honoring retry-after, and then succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fail(429, { "retry-after": "2" })).mockResolvedValueOnce(fail(502)).mockResolvedValueOnce(ok("{}"));
    const { m, sleep } = model(fetchMock);
    await m.generate(request);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
  });

  it("does not retry client errors, and names the provider without echoing the key", async () => {
    for (const status of [400, 401, 402, 403]) {
      const fetchMock = vi.fn(async () => fail(status));
      const error = await model(fetchMock).m.generate(request).catch((e) => e);
      expect(error).toMatchObject({ kind: "permanent" });
      expect(error.message).not.toContain("sk-or-123");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    const rejected = await model(vi.fn(async () => fail(401))).m.generate(request).catch((e) => e);
    expect(rejected.message).toBe("OpenRouter rejected the API key. Replace it in Settings, Integrations.");
  });

  it("treats a network failure as transient and does not retry it", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(model(fetchMock).m.generate(request)).rejects.toMatchObject({ kind: "transient" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
