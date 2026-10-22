import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest } from "../../domain/generation";
import { AnthropicMessagesModel } from "../anthropic-messages-model";

const request: GenerateRequest = {
  task: "reply.classify",
  system: [{ text: "STABLE RULES", cacheable: true }, { text: "volatile" }],
  messages: [{ role: "user", content: "SECRET-BODY please book a demo" }],
  output: { kind: "json", name: "classification", schema: { type: "object", properties: { k: { type: "string" } }, required: ["k"], additionalProperties: false } },
  maxTokens: 4000,
};

const ok = (text: string, extra: object = {}) =>
  new Response(
    JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, ...extra }),
    { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } },
  );
// `retry-after-ms` keeps the SDK's retry wait short in tests.
const fail = (status: number) => new Response(JSON.stringify({ type: "error", error: { type: "x", message: "boom" } }), { status, headers: { "content-type": "application/json", "retry-after-ms": "1" } });

const model = (fetchMock: unknown, extra: Partial<ConstructorParameters<typeof AnthropicMessagesModel>[0]> = {}) =>
  new AnthropicMessagesModel({ apiKey: "sk-test-123", model: "claude-sonnet-5-5", fetch: fetchMock as typeof fetch, ...extra });

const sent = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => {
  const [url, init] = fetchMock.mock.calls[call] as [string | URL, RequestInit];
  return { url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) };
};

describe("AnthropicMessagesModel", () => {
  it("posts the Messages API shape: closed schema in output_config, cache_control on stable system text", async () => {
    const fetchMock = vi.fn(async () => ok('{"k":"v"}'));
    const result = await model(fetchMock).generate(request);
    expect(result).toMatchObject({ text: '{"k":"v"}', stop: "end", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3 }, requestId: "req_1" });

    const { url, headers, body } = sent(fetchMock);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers.get("x-api-key")).toBe("sk-test-123");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.max_tokens).toBe(4000);
    expect(body.tool_choice).toBeUndefined();
    expect(body.output_config.format).toEqual({ type: "json_schema", schema: request.output.kind === "json" ? request.output.schema : null });
    expect(body.system).toEqual([{ type: "text", text: "STABLE RULES", cache_control: { type: "ephemeral" } }, { type: "text", text: "volatile" }]);
    expect(body.messages[0].content).toContain("SECRET-BODY");
  });

  it("serves Vercel AI Gateway at its base URL with the gateway's model id", async () => {
    const fetchMock = vi.fn(async () => ok("{}"));
    const gateway = model(fetchMock, { baseURL: "https://ai-gateway.vercel.sh", model: "anthropic/claude-sonnet-5.5", provider: "vercel-ai-gateway", label: "Vercel AI Gateway" });
    await gateway.generate(request);
    const { url, body } = sent(fetchMock);
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/messages");
    expect(body.model).toBe("anthropic/claude-sonnet-5.5");
    expect(gateway.provider).toBe("vercel-ai-gateway");
  });

  it("maps refusal and truncation to the shared stop reasons", async () => {
    expect((await model(vi.fn(async () => ok("{}", { stop_reason: "refusal" }))).generate(request)).stop).toBe("refusal");
    expect((await model(vi.fn(async () => ok("{", { stop_reason: "max_tokens" }))).generate(request)).stop).toBe("max_tokens");
  });

  it("retries 429 and 5xx through the SDK and then succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(fail(529)).mockResolvedValueOnce(ok("{}"));
    await model(fetchMock).generate(request);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after the retry budget with a transient error", async () => {
    const fetchMock = vi.fn(async () => fail(503));
    await expect(model(fetchMock, { maxRetries: 2 }).generate(request)).rejects.toMatchObject({ kind: "transient" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors, and names the provider without echoing the key", async () => {
    for (const status of [400, 401, 403, 402]) {
      const fetchMock = vi.fn(async () => fail(status));
      const error = await model(fetchMock, { label: "Vercel AI Gateway" }).generate(request).catch((e) => e);
      expect(error).toMatchObject({ kind: "permanent" });
      expect(error.message).not.toContain("sk-test-123");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (status === 401) expect(error.message).toBe("Vercel AI Gateway rejected the API key. Replace it in Settings, Integrations.");
    }
  });

  it("treats a network failure as transient", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(model(fetchMock, { maxRetries: 0 }).generate(request)).rejects.toMatchObject({ kind: "transient", message: "Could not reach the AI service." });
  });
});
