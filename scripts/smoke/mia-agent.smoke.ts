import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentMessage, AgentTool } from "@/contexts/ai/application/agent-ports";
import { buildAgentModel } from "@/contexts/ai/infrastructure/sdk-agent-model";
import { AI_CONNECTIONS } from "@/contexts/integrations/domain/ai-connections";

/**
 * What a Mia run needs from each real connection, which no mock can prove: tool calls, a stored conversation that goes on
 * after a round through JSON (signed thinking blocks included), a reminder after plain text, and how long a step takes and
 * what it costs. It spends a little of each provider's money. Set the keys and run it by hand, never in CI:
 *
 *   ANTHROPIC_API_KEY=... AI_GATEWAY_API_KEY=... OPENROUTER_API_KEY=... pnpm exec vitest run --config scripts/smoke/vitest.config.mts mia-agent
 *
 * `MIA_SMOKE_GATEWAY_MODEL` and `MIA_SMOKE_OPENROUTER_MODEL` pick the model on the connections with no default.
 */

const CASES = [
  { key: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.MIA_SMOKE_ANTHROPIC_MODEL ?? "claude-sonnet-5-5" },
  { key: "vercel-ai-gateway", apiKey: process.env.AI_GATEWAY_API_KEY, model: process.env.MIA_SMOKE_GATEWAY_MODEL ?? "anthropic/claude-sonnet-5.5" },
  { key: "openrouter", apiKey: process.env.OPENROUTER_API_KEY, model: process.env.MIA_SMOKE_OPENROUTER_MODEL ?? "anthropic/claude-sonnet-5.5" },
] as const;

const SYSTEM = [{ text: "You look up one fact, then report it by calling `finish` with the answer. Always use a tool." }];

function tools() {
  const asked: string[] = [];
  const finished: string[] = [];
  const lookup: AgentTool<{ name: string }> = {
    name: "lookup",
    description: "Reads the price of a plan.",
    input: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      asked.push(name);
      return "The Starter plan costs USD 99 per month.";
    },
  };
  const finish: AgentTool<{ answer: string }> = {
    name: "finish",
    description: "Reports the answer and ends the job.",
    input: z.object({ answer: z.string() }),
    execute: async ({ answer }) => {
      finished.push(answer);
      return "Done.";
    },
  };
  return { list: [lookup, finish] as unknown as AgentTool<never>[], asked, finished };
}

describe.each(CASES)("Mia on $key ($model)", ({ key, apiKey, model }) => {
  const spec = AI_CONNECTIONS.find((c) => c.key === key)!;

  it.skipIf(!apiKey)(
    "calls a tool, goes on from stored messages, and reports usage",
    async () => {
      const agent = buildAgentModel(spec, { apiKey: apiKey as string, model });
      const { list, asked, finished } = tools();
      let messages: AgentMessage[] = [{ role: "user", content: "What does the Starter plan cost per month?" }];
      const report: unknown[] = [];
      for (let step = 0; step < 4 && finished.length === 0; step++) {
        const started = Date.now();
        const result = await agent.step({ task: "mia.brain_fill", system: SYSTEM, messages, tools: list, maxTokens: 2000, timeoutMs: 40_000 });
        report.push({ step, ms: Date.now() - started, stop: result.stop, tools: result.toolCalls.map((c) => c.name), usage: result.usage });
        // The round a checkpoint takes: a signed thinking block or tool id that does not survive it fails the next step.
        messages = JSON.parse(JSON.stringify(result.messages)) as AgentMessage[];
        if (result.toolCalls.length === 0) messages.push({ role: "user", content: "Use a tool." });
      }
      console.log(JSON.stringify({ key, model, report }, null, 2));
      expect(asked.length).toBeGreaterThan(0);
      expect(finished.join(" ")).toMatch(/99/);
      expect((report[0] as { usage: { inputTokens: number } }).usage.inputTokens).toBeGreaterThan(0);
    },
    180_000,
  );
});
