import type { AgentMessage, AgentModel, AgentStepRequest, AgentStepResult, AgentTool } from "@/contexts/ai/application/agent-ports";
import type { PageReader } from "../application/mia-ports";

/** Demos and tests (`AI_PROVIDER=fake`): a fixed path through the tools, and a fixed page, with no model and no network. */

export const FAKE_PAGE_TEXT = "Acme Demo books your sales meetings. The Starter plan costs USD 99 per month.";
export const FAKE_PAGE_LINK = "https://fake-mia.test/pricing";

export const fakePageReader: PageReader = {
  async read(url) {
    return { url, title: "Acme Demo", text: FAKE_PAGE_TEXT, links: [FAKE_PAGE_LINK] };
  },
};

const ADDRESS = /https:\/\/[^\s]+/;
const FENCED = /<untrusted_text_[^>]+>\n([\s\S]*?)\n<\/untrusted_text_/;

const toolNamed = (tools: readonly AgentTool<never>[], name: string) => tools.find((t) => t.name === name) as unknown as AgentTool<unknown> | undefined;

/** Steps so far: the fake leaves one assistant message per step. */
const stepsOf = (messages: readonly AgentMessage[]) => messages.filter((m) => m.role === "assistant").length;

const firstText = (messages: readonly AgentMessage[]) => String(messages.find((m) => m.role === "user")?.content ?? "");

/** A plan whose monthly price the page states and whose yearly price it does not, so a review has something to catch. */
const PLAN = (source: string) => ({
  kind: "price_book",
  fields: [
    { key: "entryName", value: "Starter", quote: "The Starter plan", source },
    { key: "pricing.currency", value: "USD", quote: "USD 99 per month", source },
    { key: "monthlyPrice", value: 99, quote: "USD 99 per month", source },
    { key: "annualPrice", value: 990, quote: "USD 99 per month", source },
  ],
});

export const fakeAgentModel: AgentModel = {
  provider: "fake",
  model: "fake-mia",
  async step(request: AgentStepRequest): Promise<AgentStepResult> {
    const step = stepsOf(request.messages);
    const opening = firstText(request.messages);
    const url = ADDRESS.exec(opening)?.[0];
    const fetch = toolNamed(request.tools, "fetch_page");
    const suggest = toolNamed(request.tools, "suggest_item");
    const finish = toolNamed(request.tools, "finish");
    const calls: AgentStepResult["toolCalls"] = [];
    const run = async (tool: AgentTool<unknown> | undefined, input: unknown) => {
      if (!tool) return;
      await tool.execute(input);
      calls.push({ name: tool.name, failed: false });
    };

    if (fetch && step === 0) await run(fetch, { url });
    else if (fetch && step === 1) await run(suggest, PLAN(url as string));
    else if (!fetch && step === 0) {
      const text = FENCED.exec(opening)?.[1] ?? "";
      const line = text.split("\n")[0];
      await run(suggest, { kind: "product", fields: [{ key: "productName", value: line.slice(0, 60), quote: line, source: "input" }, { key: "overview", value: line, quote: line, source: "input" }] });
    } else await run(finish, {});
    return {
      messages: [...request.messages, { role: "assistant", content: `Step ${step + 1}.` }],
      toolCalls: calls,
      stop: "tools",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};
