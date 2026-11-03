import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { clientNameFrom, logMcp, mcpActor, runTool, type ToolOutput } from "@/app/_lib/mcp";
import type { McpPrincipal, PrincipalAllowance } from "@/contexts/agent-access/application/mcp-principal";
import { callTarget, type McpToolCallEntry } from "@/contexts/agent-access/application/mcp-tool-calls";
import { hasScope, type McpScope } from "@/contexts/agent-access/domain/mcp-policy";
import type { McpRateBucket } from "@/contexts/agent-access/domain/mcp-rate-limit";
import { ConflictError, ValidationError, type Actor } from "@/shared/errors";
import { CARD_MIME_TYPE, CARDS } from "./cards";
import { estimateTokens, MAX_RESPONSE_TOKENS, toolOutputContext, type ToolOutputContext } from "./output";

/** Reads this organization's data and changes nothing. */
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
  /** The part of the policies it needs, so `tools/list` leaves it out while the policy refuses. */
  needs?: PrincipalAllowance;
  annotations: ToolAnnotations;
  /** The MCP Apps card a host that supports them shows beside the answer (`cards.ts`). */
  card?: string;
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

/** An input an action of a tool requires: "edit needs draftId." when the agent left it out. */
export const need = <T>(value: T | undefined, what: string, action: string): T => {
  if (value === undefined) throw new ValidationError(`${action} needs ${what}.`);
  return value;
};

/**
 * Runs a tool and holds its answer to the response budget. Tools trim their own lists; this is the check that no tool
 * can skip, so an oversize answer becomes a tool error the agent can act on instead of a flood in its context. A tool
 * that changes data has already changed it by now, so its answer goes out as it is: a refusal would read as a failure,
 * and the agent would run it again.
 */
export async function withinBudget<T extends Record<string, unknown>>(run: () => Promise<ToolOutput<T>>, changesData = false): Promise<ToolOutput<T>> {
  const output = await run();
  if (!changesData && estimateTokens(output) > MAX_RESPONSE_TOKENS) {
    throw new ConflictError("This answer is too large for one call. Narrow it with the tool's filters, a shorter date range or a later page.", { code: "answer_too_large" });
  }
  return output;
}

/**
 * The output schema `tools/list` publishes: the top-level keys only. Full schemas for eleven tools would cost more
 * than the whole definition budget, and an agent reads the structured content itself. `checkedOutput` still holds
 * every answer to the tool's full schema. Every key is optional and `error` is listed because a refusal answers
 * `{ error }` alone: a client that checks results against this schema, as the v1 TypeScript SDK does, would otherwise
 * throw and lose the refusal.
 */
export const publishedOutput = (output: AnyObject) => z.object({ ...Object.fromEntries(Object.keys(output.shape).map((key) => [key, z.unknown().optional()])), error: z.unknown().optional() });

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
  conversation: (entry: McpToolCallEntry) => Promise<void>;
  now: () => number;
}

/** A read-only tool counts as a read whatever scope it needs, such as preview_campaign_launch under `mcp:send`. */
const bucketsOf = (tool: ToolDefinition, input: unknown): McpRateBucket[] => tool.buckets?.(input as never) ?? (tool.scope === "mcp:read" || tool.annotations.readOnlyHint ? [] : ["write"]);

/** What a token ran out of, by bucket, for the refusal's sentence. */
const LIMIT_WORDS: Record<McpRateBucket, string> = {
  read: "requests this minute",
  write: "changes this minute",
  ai: "AI drafts this hour",
  import: "imports this hour",
  send: "sent replies this minute",
  launch: "campaign starts this hour",
  spend: "enrichment runs and searches this hour",
  irreversible: "actions it cannot undo this hour",
};

/** Counts the call in each of its buckets, all of them even after one refuses, so a client that keeps retrying stays refused. */
async function takeBuckets(hooks: ToolHooks, buckets: McpRateBucket[]): Promise<void> {
  let wait: number | null = null;
  const refused: McpRateBucket[] = [];
  for (const bucket of buckets) {
    const seconds = await hooks.take(bucket);
    if (seconds === null) continue;
    refused.push(bucket);
    wait = Math.max(wait ?? 0, seconds);
  }
  if (wait !== null) {
    const what = refused.map((bucket) => LIMIT_WORDS[bucket]).join(" and ");
    throw new ConflictError(`This token made too many ${what}. Try again in ${wait} seconds.`, { code: "rate_limited", retryAfterSeconds: wait });
  }
}

/** Whether this token sees the tool: its scope, and the policy the tool needs. */
export const toolVisible = (tool: ToolDefinition, principal: McpPrincipal): boolean => hasScope(principal.scopes, tool.scope) && (!tool.needs || principal.allows[tool.needs]);

const actionOf = (input: unknown): string | null => {
  const action = (input as Record<string, unknown> | null | undefined)?.action;
  return typeof action === "string" ? action : null;
};

/** The card of each tool the token sees, so a host can read the one a tool names. The pages hold no data. */
function registerCards(server: McpServer, tools: readonly ToolDefinition[]): void {
  for (const uri of new Set(tools.flatMap((tool) => (tool.card ? [tool.card] : [])))) {
    const card = CARDS[uri];
    server.registerResource(card.name, uri, { description: card.description, mimeType: CARD_MIME_TYPE }, async () => ({ contents: [{ uri, mimeType: CARD_MIME_TYPE, text: card.html }] }));
  }
}

/**
 * Registers the tools the token's scopes and the policies allow, by name, so `tools/list` comes out in the same order every time. Each
 * call runs through `runTool` with the person's actor and a fresh output context: its rate buckets first, then the
 * tool within the response budget. Every call, refused or not, writes one row to the activity log; a failed write
 * there is logged and never fails the call. `connectionClient` names a client whose requests do not name it.
 */
export function registerTools(server: McpServer, principal: McpPrincipal, appUrl: string, tools: readonly ToolDefinition[], hooks: ToolHooks, connectionClient: string | null = null): void {
  const visible = [...tools].sort((a, b) => a.name.localeCompare(b.name)).filter((tool) => toolVisible(tool, principal));
  registerCards(server, visible);
  for (const tool of visible) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, outputSchema: publishedOutput(tool.output), annotations: tool.annotations, ...(tool.card ? { _meta: { ui: { resourceUri: tool.card } } } : {}) },
      async (input, extra) => {
        const started = hooks.now();
        const clientName = clientNameFrom(extra.mcpReq.envelope) ?? connectionClient;
        const buckets = bucketsOf(tool, input);
        const result = await runTool(tool.name, mcpActor(principal, clientName), async (actor) => {
          await takeBuckets(hooks, buckets);
          return withinBudget(() => checkedOutput(tool, () => tool.run({ actor, principal, out: toolOutputContext(appUrl) }, input as never)), buckets.length > 0);
        });
        const error = result.isError ? (result.structuredContent?.error as { code?: unknown } | undefined) : undefined;
        // Operators watch refused agent actions and rate limits in the logs (docs/operations.md).
        if (typeof error?.code === "string" && (error.code.startsWith("agent_") || error.code === "rate_limited")) {
          logMcp(error.code === "rate_limited" ? "rate limited" : "agent action refused", { code: error.code, tool: tool.name, organizationId: principal.organizationId, tokenId: principal.tokenId });
        }
        await hooks
          .conversation({
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
