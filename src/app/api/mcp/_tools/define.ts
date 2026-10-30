import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { clientNameFrom, mcpActor, runTool, type ToolOutput } from "@/app/_lib/mcp";
import type { McpPrincipal } from "@/contexts/tenancy/application/mcp-principal";
import { callTarget, type McpToolCallEntry } from "@/contexts/tenancy/application/mcp-tool-calls";
import { hasScope, type McpScope } from "@/contexts/tenancy/domain/mcp-policy";
import type { McpRateBucket } from "@/contexts/tenancy/domain/mcp-rate-limit";
import { ConflictError, type Actor } from "@/shared/errors";
import { estimateTokens, MAX_RESPONSE_TOKENS, toolOutputContext, type ToolOutputContext } from "./output";

/** Reads this organization's data and changes nothing (the plan's "RO, CW"). */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** Changes this organization's data and reaches nothing outside it. Destructive by the protocol's default. */
export const CHANGES: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

/** What a tool's `run` gets besides its input. */
export interface ToolContext {
  /** The token's person, marked with `via`. */
  actor: Actor;
  principal: McpPrincipal;
  out: ToolOutputContext;
}

type AnyObject = z.ZodObject<z.ZodRawShape>;

export interface ToolDefinition<I extends AnyObject = AnyObject, O extends AnyObject = AnyObject> {
  name: string;
  title: string;
  description: string;
  scope: McpScope;
  annotations: ToolAnnotations;
  input: I;
  output: O;
  /**
   * The rate buckets a call counts in besides `read`, which the route counts for every request. A tool that changes
   * data counts in `write` unless it says otherwise; an action that calls a model or imports adds its own bucket.
   */
  buckets?: (input: z.infer<I>) => McpRateBucket[];
  run: (ctx: ToolContext, input: z.infer<I>) => Promise<ToolOutput<z.infer<O>>>;
}

/** Keeps the input and output types of one definition tied together. */
export const defineTool = <I extends AnyObject, O extends AnyObject>(definition: ToolDefinition<I, O>): ToolDefinition => definition as unknown as ToolDefinition;

/**
 * Runs a tool and holds its answer to the response budget. Tools trim their own lists; this is the check that no tool
 * can skip, so an oversize answer becomes a tool error the agent can act on instead of a flood in its context.
 */
export async function withinBudget<T extends Record<string, unknown>>(run: () => Promise<ToolOutput<T>>): Promise<ToolOutput<T>> {
  const output = await run();
  if (estimateTokens(output) > MAX_RESPONSE_TOKENS) {
    throw new ConflictError("This answer is too large for one call. Narrow it with the tool's filters, a shorter date range or a later page.", { code: "answer_too_large" });
  }
  return output;
}

/**
 * The output schema `tools/list` publishes: the top-level keys only. Full schemas for eleven tools would cost more
 * than the whole definition budget, and an agent reads the structured content itself. `checkedOutput` still holds
 * every answer to the tool's full schema.
 */
export const publishedOutput = (output: AnyObject) => z.object(Object.fromEntries(Object.keys(output.shape).map((key) => [key, z.unknown()])));

/** The answer, checked against the tool's full output schema. A mismatch is a bug here, so it is logged as one. */
export async function checkedOutput<T extends Record<string, unknown>>(tool: Pick<ToolDefinition, "name" | "output">, run: () => Promise<ToolOutput<T>>): Promise<ToolOutput<T>> {
  const output = await run();
  const parsed = tool.output.safeParse(output.structured);
  if (!parsed.success) throw new Error(`${tool.name} answered outside its output schema: ${parsed.error.message}`);
  return output;
}

/** What `registerTools` needs from outside the tools: the per-token rate buckets and the activity log. */
export interface ToolHooks {
  /** Counts the call in a bucket; the seconds to wait when the token is over its limit, else null. */
  take: (bucket: McpRateBucket) => Promise<number | null>;
  record: (entry: McpToolCallEntry) => Promise<void>;
  now: () => number;
}

const bucketsOf = (tool: ToolDefinition, input: unknown): McpRateBucket[] => tool.buckets?.(input as never) ?? (tool.scope === "mcp:read" ? [] : ["write"]);

/** Counts the call in each of its buckets, all of them even after one refuses, so a client that keeps retrying stays refused. */
async function takeBuckets(hooks: ToolHooks, buckets: McpRateBucket[]): Promise<void> {
  let wait: number | null = null;
  for (const bucket of buckets) {
    const seconds = await hooks.take(bucket);
    if (seconds !== null) wait = Math.max(wait ?? 0, seconds);
  }
  if (wait !== null) {
    throw new ConflictError(`This token made too many changes for now. Try again in ${wait} seconds.`, { code: "rate_limited", retryAfterSeconds: wait });
  }
}

const actionOf = (input: unknown): string | null => {
  const action = (input as Record<string, unknown> | null | undefined)?.action;
  return typeof action === "string" ? action : null;
};

/**
 * Registers the tools the token's scopes allow, by name, so `tools/list` comes out in the same order every time. Each
 * call runs through `runTool` with the person's actor and a fresh output context: its rate buckets first, then the
 * tool within the response budget. Every call, refused or not, writes one row to the activity log; a failed write
 * there is logged and never fails the call.
 */
export function registerTools(server: McpServer, principal: McpPrincipal, appUrl: string, tools: readonly ToolDefinition[], hooks: ToolHooks): void {
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!hasScope(principal.scopes, tool.scope)) continue;
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, outputSchema: publishedOutput(tool.output), annotations: tool.annotations },
      async (input, extra) => {
        const started = hooks.now();
        const clientName = clientNameFrom(extra.mcpReq.envelope);
        const buckets = bucketsOf(tool, input);
        const result = await runTool(tool.name, mcpActor(principal, clientName), async (actor) => {
          await takeBuckets(hooks, buckets);
          return withinBudget(() => checkedOutput(tool, () => tool.run({ actor, principal, out: toolOutputContext(appUrl) }, input as never)));
        });
        const error = result.isError ? (result.structuredContent?.error as { code?: unknown } | undefined) : undefined;
        await hooks
          .record({
            organizationId: principal.organizationId,
            tokenId: principal.tokenId,
            tool: tool.name,
            action: actionOf(input),
            kind: buckets.includes("write") ? "write" : "read",
            target: callTarget(input),
            errorCode: result.isError ? (typeof error?.code === "string" ? error.code : "server_error") : null,
            clientName,
            durationMs: Math.max(0, Math.round(hooks.now() - started)),
          })
          .catch((cause) => console.error(`[mcp] could not log a ${tool.name} call for organization ${principal.organizationId}`, cause));
        return result;
      },
    );
  }
}
