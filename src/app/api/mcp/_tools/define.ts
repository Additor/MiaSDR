import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { clientNameFrom, mcpActor, runTool, type ToolOutput } from "@/app/_lib/mcp";
import type { McpPrincipal } from "@/contexts/tenancy/application/mcp-principal";
import { hasScope, type McpScope } from "@/contexts/tenancy/domain/mcp-policy";
import type { Actor } from "@/shared/errors";
import { toolOutputContext, type ToolOutputContext } from "./output";

/** Reads this organization's data and changes nothing (the plan's "RO, CW"). */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

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
  run: (ctx: ToolContext, input: z.infer<I>) => Promise<ToolOutput<z.infer<O>>>;
}

/** Keeps the input and output types of one definition tied together. */
export const defineTool = <I extends AnyObject, O extends AnyObject>(definition: ToolDefinition<I, O>): ToolDefinition => definition as unknown as ToolDefinition;

/**
 * Registers the tools the token's scopes allow, by name, so `tools/list` comes out in the same order every time. Each
 * call runs through `runTool` with the person's actor and a fresh output context.
 */
export function registerTools(server: McpServer, principal: McpPrincipal, appUrl: string, tools: readonly ToolDefinition[]): void {
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!hasScope(principal.scopes, tool.scope)) continue;
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, outputSchema: tool.output, annotations: tool.annotations },
      (input, extra) =>
        runTool(tool.name, mcpActor(principal, clientNameFrom(extra.mcpReq.envelope)), (actor) =>
          tool.run({ actor, principal, out: toolOutputContext(appUrl) }, input as never),
        ),
    );
  }
}
