import { describe, expect, it, vi } from "vitest";
import { AiError } from "../../application/ai-ports";
import type { ClassifyInput } from "../../domain/ai-contract";
import { AnthropicAiProvider } from "../anthropic-ai-provider";

const input: ClassifyInput = {
  taxonomy: [
    { key: "demo_request", name: "Demo request", categoryKey: "interested", description: null, guidance: null },
    { key: "other", name: "Other", categoryKey: "other", description: null, guidance: null },
  ],
  person: { name: "Eve", email: "eve@x.test", title: null, company: null },
  thread: [{ direction: "inbound", at: new Date("2026-10-14T10:00:00Z"), subject: "Hi", text: "SECRET-BODY please book a demo" }],
  operatorInstructions: "",
  businessContext: "",
};

const ok = (text: string, extra: object = {}) =>
  new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, ...extra }), { status: 200 });
const fail = (status: number, headers: Record<string, string> = {}) => new Response(JSON.stringify({ type: "error", error: { type: "x", message: "boom" } }), { status, headers });

function provider(fetchMock: typeof fetch, extra: Partial<ConstructorParameters<typeof AnthropicAiProvider>[0]> = {}) {
  const sleep = vi.fn(async () => undefined);
  return { p: new AnthropicAiProvider({ apiKey: "sk-test-123", fetch: fetchMock, sleep, ...extra }), sleep };
}

describe("AnthropicAiProvider", () => {
  it("posts the documented request shape with a closed JSON schema", async () => {
    const fetchMock = vi.fn(async () => ok(JSON.stringify({ subcategoryKey: "demo_request", confidence: 0.9, reason: "Asks for a demo." })));
    const { p } = provider(fetchMock as unknown as typeof fetch);
    const result = await p.classify(input);
    expect(result.output.subcategoryKey).toBe("demo_request");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-api-key": "sk-test-123", "anthropic-version": "2023-06-01", "content-type": "application/json" });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toHaveLength(1);
    expect(body.tool_choice).toBeUndefined();
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.properties.subcategoryKey.enum).toEqual(["demo_request", "other"]);
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(body.messages[0].content).toContain("SECRET-BODY");
  });

  it("returns an over-long text answer so the caller can reject it, and does not retry the paid call", async () => {
    const fetchMock = vi.fn(async () => ok(JSON.stringify({ blob: JSON.stringify({ k: "y".repeat(6000) }) })));
    const { p } = provider(fetchMock as unknown as typeof fetch);
    const result = await p.answer({ instruction: "x", cells: [], outputs: [{ key: "blob", type: "json" }] });
    expect(String(result.output.blob).length).toBeGreaterThan(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the configured model", async () => {
    const fetchMock = vi.fn(async () => ok(JSON.stringify({ subcategoryKey: "other", confidence: 0.1, reason: "r" })));
    const { p } = provider(fetchMock as unknown as typeof fetch, { model: "claude-custom" });
    await p.classify(input);
    expect(JSON.parse(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).model).toBe("claude-custom");
  });

  it("retries 429 and 5xx with backoff, honoring retry-after, and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fail(429, { "retry-after": "2" }))
      .mockResolvedValueOnce(fail(529))
      .mockResolvedValueOnce(ok(JSON.stringify({ subcategoryKey: "other", confidence: 0.2, reason: "r" })));
    const { p, sleep } = provider(fetchMock as unknown as typeof fetch);
    await p.classify(input);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget with a transient error", async () => {
    const fetchMock = vi.fn(async () => fail(503));
    const { p } = provider(fetchMock as unknown as typeof fetch, { maxRetries: 2 });
    await expect(p.classify(input)).rejects.toMatchObject({ kind: "transient" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors", async () => {
    for (const status of [400, 401, 403]) {
      const fetchMock = vi.fn(async () => fail(status));
      const { p } = provider(fetchMock as unknown as typeof fetch);
      await expect(p.classify(input)).rejects.toMatchObject({ kind: "permanent" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("reports a rejected key without echoing it", async () => {
    const { p } = provider((async () => fail(401)) as unknown as typeof fetch);
    const error = await p.classify(input).catch((e: AiError) => e);
    expect((error as AiError).message).not.toContain("sk-test-123");
    expect((error as AiError).message).toMatch(/rejected the API key/);
  });

  it("treats a network failure or timeout as transient and does not retry it", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const { p } = provider(fetchMock as unknown as typeof fetch);
    await expect(p.classify(input)).rejects.toMatchObject({ kind: "transient" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an answer outside the closed set, refusals and truncation", async () => {
    const outside = provider((async () => ok(JSON.stringify({ subcategoryKey: "wire_money", confidence: 1, reason: "x" }))) as unknown as typeof fetch).p;
    await expect(outside.classify(input)).rejects.toMatchObject({ kind: "transient" });
    const extra = provider((async () => ok(JSON.stringify({ subcategoryKey: "other", confidence: 1, reason: "x", send: true }))) as unknown as typeof fetch).p;
    await expect(extra.classify(input)).rejects.toBeInstanceOf(AiError);
    const refusal = provider((async () => ok("{}", { stop_reason: "refusal" })) as unknown as typeof fetch).p;
    await expect(refusal.classify(input)).rejects.toMatchObject({ kind: "permanent" });
    const cut = provider((async () => ok("{", { stop_reason: "max_tokens" })) as unknown as typeof fetch).p;
    await expect(cut.classify(input)).rejects.toMatchObject({ kind: "transient" });
    const notJson = provider((async () => ok("not json")) as unknown as typeof fetch).p;
    await expect(notJson.classify(input)).rejects.toMatchObject({ kind: "transient" });
  });

  it("drafts through the same path and validates the draft shape", async () => {
    const good = provider((async () => ok(JSON.stringify({ subject: "Re: Hi", bodyText: "Hello" }))) as unknown as typeof fetch).p;
    const result = await good.draft({ channel: "email", person: input.person, thread: input.thread, subject: "Re: Hi", classification: null, stageChange: null, operatorInstructions: "", knowledge: [], feedback: null, previousDraft: null, senderName: null });
    expect(result.output.bodyText).toBe("Hello");
    const bad = provider((async () => ok(JSON.stringify({ subject: "x" }))) as unknown as typeof fetch).p;
    await expect(bad.draft({ channel: "email", person: input.person, thread: input.thread, subject: "Re: Hi", classification: null, stageChange: null, operatorInstructions: "", knowledge: [], feedback: null, previousDraft: null, senderName: null })).rejects.toBeInstanceOf(AiError);
  });

  it("asks for a body only on LinkedIn and returns no subject", async () => {
    const fetchMock = vi.fn(async () => ok(JSON.stringify({ bodyText: "Thursday works." })));
    const { p } = provider(fetchMock as unknown as typeof fetch);
    const result = await p.draft({ channel: "linkedin", person: input.person, thread: input.thread, subject: "", classification: null, stageChange: null, operatorInstructions: "", knowledge: [], feedback: null, previousDraft: null, senderName: null });
    expect(result.output).toEqual({ subject: "", bodyText: "Thursday works." });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.output_config.format.schema.required).toEqual(["bodyText"]);
    expect(body.system).toMatch(/LinkedIn/);
  });
});
