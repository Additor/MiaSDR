import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool } from "../../application/agent-ports";
import { buildAgentModel, SdkAgentModel } from "../sdk-agent-model";
import { AI_CONNECTIONS } from "@/contexts/integrations/domain/ai-connections";

const usage = { inputTokens: { total: 130, noCache: 100, cacheRead: 20, cacheWrite: 10 }, outputTokens: { total: 40, text: 40, reasoning: undefined } };

const answer = (content: unknown[], unified: string) => ({ content, finishReason: { unified, raw: undefined }, usage, warnings: [] });

const called = vi.fn(async (input: { name: string }) => `read ${input.name}`);
const lookup: AgentTool<{ name: string }> = { name: "lookup", description: "Reads one thing.", input: z.object({ name: z.string() }), execute: called };

const modelWith = (doGenerate: () => unknown) => new SdkAgentModel({ sdkModel: new MockLanguageModelV4({ doGenerate: doGenerate as never }), provider: "anthropic", model: "m", label: "Anthropic", cacheProvider: "anthropic" });

const request = {
  task: "mia.brain_fill" as const,
  system: [{ text: "Be careful." }],
  messages: [{ role: "user", content: "Start." }],
  tools: [lookup as unknown as AgentTool<never>],
  maxTokens: 1000,
  timeoutMs: 5000,
};

afterEach(() => called.mockClear());

describe("SdkAgentModel", () => {
  it("runs one step: the tool's result joins the messages and the next step can continue from them", async () => {
    const model = modelWith(async () => answer([{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: '{"name":"pricing"}' }], "tool-calls"));
    const result = await model.step(request);
    expect(called).toHaveBeenCalledTimes(1);
    expect(called.mock.calls[0][0]).toEqual({ name: "pricing" });
    expect(result.stop).toBe("tools");
    expect(result.toolCalls).toEqual([{ name: "lookup", failed: false }]);
    expect(result.messages[0]).toEqual({ role: "user", content: "Start." });
    expect(JSON.stringify(result.messages)).toContain("read pricing");
    // The stored list goes back through JSON and into a second step.
    const again = modelWith(async () => answer([{ type: "text", text: "Done." }], "stop"));
    const next = await again.step({ ...request, messages: JSON.parse(JSON.stringify(result.messages)) });
    expect(next.stop).toBe("end");
    expect(next.toolCalls).toEqual([]);
  });

  it("keeps cached tokens apart from fresh input", async () => {
    const result = await modelWith(async () => answer([{ type: "text", text: "Hi" }], "stop")).step(request);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 10 });
  });

  it("marks system text cacheable and sends only the tools a step allows", async () => {
    const doGenerate = vi.fn(async () => answer([{ type: "text", text: "Hi" }], "stop"));
    const other: AgentTool<{ name: string }> = { ...lookup, name: "other" };
    await new SdkAgentModel({ sdkModel: new MockLanguageModelV4({ doGenerate: doGenerate as never }), provider: "anthropic", model: "m", label: "Anthropic", cacheProvider: "anthropic" }).step({
      ...request,
      tools: [lookup, other] as unknown as AgentTool<never>[],
      activeTools: ["other"],
    });
    const options = (doGenerate.mock.calls as unknown as Array<[{ prompt: Array<{ role: string; providerOptions?: unknown }>; tools: Array<{ name: string }> }]>)[0][0];
    expect(options.prompt[0]).toMatchObject({ role: "system", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } });
    expect(options.tools.map((t) => t.name)).toEqual(["other"]);
  });

  it("returns a tool's failure to the model and says the call failed", async () => {
    const failing: AgentTool<{ name: string }> = { ...lookup, execute: async () => { throw new Error("nope"); } };
    const model = modelWith(async () => answer([{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: '{"name":"x"}' }], "tool-calls"));
    const result = await model.step({ ...request, tools: [failing as unknown as AgentTool<never>] });
    expect(result.toolCalls).toEqual([{ name: "lookup", failed: true }]);
    expect(JSON.stringify(result.messages)).toContain("nope");
  });

  it.each([
    [401, "permanent", /rejected the API key/],
    [402, "permanent", /billing/],
    [429, "transient", /unavailable/],
    [503, "transient", /unavailable/],
    [404, "permanent", /rejected the request/],
  ])("reads status %i as a %s failure", async (statusCode, kind, message) => {
    const model = modelWith(async () => {
      throw new APICallError({ message: "No endpoints support tool use", url: "https://x.test", requestBodyValues: {}, statusCode, isRetryable: false });
    });
    await expect(model.step(request)).rejects.toMatchObject({ kind, message: expect.stringMatching(message) });
  });

  it("reads a timeout as transient and asks the SDK for no retry of its own", async () => {
    const doGenerate = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      throw error;
    });
    const model = new SdkAgentModel({ sdkModel: new MockLanguageModelV4({ doGenerate: doGenerate as never }), provider: "anthropic", model: "m", label: "Anthropic" });
    await expect(model.step(request)).rejects.toMatchObject({ kind: "transient", message: "The AI request timed out." });
    expect(doGenerate).toHaveBeenCalledTimes(1);
  });
});

describe("buildAgentModel", () => {
  const bodyFetch = (seen: { url?: string; headers?: Headers; body?: Record<string, unknown> }) => async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(url);
    seen.headers = new Headers(init?.headers);
    seen.body = JSON.parse(String(init?.body));
    throw new Error("stop after the request");
  };

  it.each(["anthropic", "vercel-ai-gateway"])("calls %s's Messages endpoint under /v1 with the saved key", async (key) => {
    const seen: { url?: string; headers?: Headers } = {};
    vi.stubGlobal("fetch", bodyFetch(seen));
    const spec = AI_CONNECTIONS.find((c) => c.key === key)!;
    await expect(buildAgentModel(spec, { apiKey: "sk-test", model: "claude-sonnet-5-5" }).step(request)).rejects.toBeInstanceOf(Error);
    vi.unstubAllGlobals();
    expect(seen.url).toBe(`${spec.baseUrl}/v1/messages`);
    expect(seen.headers?.get("x-api-key")).toBe("sk-test");
  });

  it("goes on from a stored tool call over Anthropic's wire format, signed thinking included", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: Array<Record<string, unknown>> }>; tools: unknown[]; system: Array<Record<string, unknown>> }> = [];
    const replies = [
      { id: "m1", type: "message", role: "assistant", model: "m", stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }, content: [{ type: "thinking", thinking: "Look it up.", signature: "sig-1" }, { type: "tool_use", id: "tu_1", name: "lookup", input: { name: "pricing" } }] },
      { id: "m2", type: "message", role: "assistant", model: "m", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 20, output_tokens: 5 }, content: [{ type: "text", text: "Done." }] },
    ];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200, headers: { "content-type": "application/json" } });
    });
    const agent = buildAgentModel(AI_CONNECTIONS.find((c) => c.key === "anthropic")!, { apiKey: "sk-test", model: "claude-sonnet-5-5" });
    const first = await agent.step(request);
    expect(first).toMatchObject({ stop: "tools", toolCalls: [{ name: "lookup", failed: false }], usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 } });
    expect(bodies[0].system[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
    // The round a checkpoint takes.
    await agent.step({ ...request, messages: JSON.parse(JSON.stringify(first.messages)) });
    vi.unstubAllGlobals();
    const sent = bodies[1].messages;
    expect(sent[1].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "thinking", signature: "sig-1" }), expect.objectContaining({ type: "tool_use", id: "tu_1" })]));
    expect(sent[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    expect(JSON.stringify(sent[2].content[0])).toContain("read pricing");
  });

  it("goes on from a stored tool call over OpenRouter's wire format, and reads its cost", async () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>>; usage?: unknown }> = [];
    const replies = [
      { id: "c1", model: "m", created: 1, choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"name":"pricing"}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: 0.002 } },
      { id: "c2", model: "m", created: 2, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done." } }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } },
    ];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200, headers: { "content-type": "application/json" } });
    });
    const agent = buildAgentModel(AI_CONNECTIONS.find((c) => c.key === "openrouter")!, { apiKey: "sk-or", model: "openai/gpt-5" });
    const first = await agent.step(request);
    expect(first).toMatchObject({ stop: "tools", toolCalls: [{ name: "lookup", failed: false }], usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.002 } });
    await agent.step({ ...request, messages: JSON.parse(JSON.stringify(first.messages)) });
    vi.unstubAllGlobals();
    expect(bodies[0].usage).toEqual({ include: true });
    const tool = bodies[1].messages.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ tool_call_id: "call_1" });
    expect(JSON.stringify(tool)).toContain("read pricing");
  });

  it("calls OpenRouter's chat endpoint with the saved key", async () => {
    const seen: { url?: string; headers?: Headers; body?: Record<string, unknown> } = {};
    vi.stubGlobal("fetch", bodyFetch(seen));
    const spec = AI_CONNECTIONS.find((c) => c.key === "openrouter")!;
    await expect(buildAgentModel(spec, { apiKey: "sk-or", model: "anthropic/claude-sonnet-5.5" }).step(request)).rejects.toBeInstanceOf(Error);
    vi.unstubAllGlobals();
    expect(seen.url).toBe(`${spec.baseUrl}/chat/completions`);
    expect(seen.headers?.get("authorization")).toBe("Bearer sk-or");
    expect(seen.body?.model).toBe("anthropic/claude-sonnet-5.5");
  });
});
