import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AgentTool } from "@/contexts/ai/application/agent-ports";
import { fence } from "@/contexts/ai/domain/prompt-fence";
import { BRAIN_FIELDS, brainFieldValue } from "@/contexts/brain/domain/brain-fields";
import { BRAIN_ITEM_KINDS, SINGLE_ITEM_KIND, type BrainItemKind } from "@/contexts/brain/domain/brain-kinds";
import { ValidationError } from "@/shared/errors";
import { MIA_MAX_PAGES, MIA_MAX_SUGGESTIONS, MIA_PAGE_CHARS, MIA_RUN_TOOLS, type MiaCapability } from "../domain/mia-run";
import { INPUT_SOURCE, reviewSuggestion } from "../domain/suggestion";
import type { MiaBrainPort, NewSuggestion, PageReader } from "./mia-ports";

/** What a run carries from step to step. JSON, since it is stored between steps. */
export interface RunState {
  messages: Array<Record<string, unknown>>;
  pages: Array<{ url: string; text: string }>;
  /** Addresses `fetch_page` may open. They come from a person's input and from parsed links, never from the model's text. */
  allowedUrls: string[];
  /** Titles this run already suggested, so a repeat is refused. */
  suggested: string[];
  nudged: boolean;
  /** The text a person gave, or the document being sorted. Quotes are checked against it. */
  inputText: string | null;
  /** A document being sorted: the only item a suggestion may change. */
  sorting: { id: string; title: string } | null;
}

export interface StepTools {
  tools: AgentTool<never>[];
  /** Filled while the tools run, and stored with the step in one transaction, so a retried step writes nothing twice. */
  pending: NewSuggestion[];
  finished: () => boolean;
}

interface ToolContext {
  organizationId: string;
  capability: MiaCapability;
  state: RunState;
  sources: Map<string, string>;
  suggestionsSoFar: number;
  pages: PageReader;
  brain: MiaBrainPort;
}

const nonce = () => randomBytes(6).toString("hex");

const FIELD = z.object({
  key: z.string().describe("A field key of the kind."),
  value: z.union([z.string(), z.number(), z.array(z.string())]),
  quote: z.string().describe("The exact sentence from the source. Empty only for a choice field."),
  source: z.string().describe("The page address the sentence is on, or the word input."),
});

const SUGGEST = z.object({
  kind: z.enum(BRAIN_ITEM_KINDS as [BrainItemKind, ...BrainItemKind[]]),
  title: z.string().optional().describe("Only for a kind that needs a title."),
  fields: z.array(FIELD).max(40),
});

const asTool = <I,>(tool: AgentTool<I>) => tool as unknown as AgentTool<never>;

function fetchPageTool(ctx: ToolContext) {
  return asTool<{ url: string }>({
    name: "fetch_page",
    description: "Reads one page. It takes the address you were given, or a link listed in an earlier result.",
    input: z.object({ url: z.string() }),
    async execute({ url }) {
      if (!ctx.state.allowedUrls.includes(url)) throw new Error("That address was not given to you and is not a listed link.");
      if (ctx.state.pages.length >= MIA_MAX_PAGES) throw new Error(`You have read ${MIA_MAX_PAGES} pages. Suggest what you found and call finish.`);
      // Held before the await, so parallel calls in one step cannot pass the limit.
      const slot: { url: string; text: string } = { url, text: "" };
      ctx.state.pages.push(slot);
      let page;
      try {
        page = await ctx.pages.read(url);
      } catch (error) {
        ctx.state.pages.splice(ctx.state.pages.indexOf(slot), 1);
        throw error;
      }
      const text = page.text.slice(0, MIA_PAGE_CHARS);
      slot.text = text;
      // A redirect lands elsewhere on the site, and a quote then names the page it landed on.
      slot.url = page.url;
      ctx.sources.set(page.url, text);
      for (const link of page.links) if (!ctx.state.allowedUrls.includes(link)) ctx.state.allowedUrls.push(link);
      return [`Address: ${page.url}`, `Title: ${page.title}`, fence("page", text, nonce()), `Links you may open:\n${page.links.join("\n") || "None."}`].join("\n\n");
    },
  });
}

function suggestTool(ctx: ToolContext, pending: NewSuggestion[]) {
  return asTool<z.infer<typeof SUGGEST>>({
    name: "suggest_item",
    description: "Offers one Brain item to a person, who reviews it before anything is saved.",
    input: SUGGEST,
    async execute(input) {
      if (ctx.suggestionsSoFar + pending.length >= MIA_MAX_SUGGESTIONS) throw new Error("That is enough suggestions for one run. Call finish.");
      const { sorting } = ctx.state;
      if (sorting && pending.length + ctx.suggestionsSoFar >= 1) throw new Error("This document takes one suggestion. Call finish.");
      const { kind } = input;
      const definition = BRAIN_FIELDS[kind];
      const titleInput = input.fields.find((f) => f.key === definition.titleField)?.value;
      const title = (definition.titleField ? String(titleInput ?? "") : (input.title ?? sorting?.title ?? "")).trim();
      if (title === "") throw new Error(definition.titleField ? `${definition.titleField} is required.` : "This kind needs a title.");

      // The match happens here, so a run that reads the web learns nothing about what Brain holds.
      const target = sorting ? null : await ctx.brain.findTarget(ctx.organizationId, kind, title);
      if (sorting && kind === SINGLE_ITEM_KIND && (await ctx.brain.findTarget(ctx.organizationId, kind, title))) throw new Error("This organization already has a company profile. Pick another kind.");
      const base = target?.fields ?? {};
      let reviewed;
      try {
        reviewed = reviewSuggestion(kind, input.fields, base, ctx.sources);
      } catch (error) {
        if (error instanceof ValidationError) throw new Error(error.message);
        throw error;
      }
      const finalTitle = definition.titleField ? String(brainFieldValue(reviewed.merged, definition.titleField)) : title;
      const seen = `${kind}:${finalTitle.toLowerCase()}`;
      if (ctx.state.suggested.includes(seen)) throw new Error("You already suggested this item.");
      ctx.state.suggested.push(seen);
      pending.push({
        type: target || sorting ? "item_change" : "new_item",
        ordinal: pending.length,
        targetItemId: sorting?.id ?? target?.id ?? null,
        kind,
        title: finalTitle.slice(0, 200),
        payload: { fields: reviewed.fields, sorting: sorting !== null },
      });
      return "Suggested. A person will review it.";
    },
  });
}

/** The tools of one step. `MIA_RUN_TOOLS` decides which exist, so a capability cannot reach what its row leaves out. */
export function runTools(ctx: ToolContext): StepTools {
  const pending: NewSuggestion[] = [];
  let finished = false;
  const all = {
    fetch_page: () => fetchPageTool(ctx),
    suggest_item: () => suggestTool(ctx, pending),
    finish: () =>
      asTool<Record<string, never>>({
        name: "finish",
        description: "Ends the job. Call it when you have suggested what you found.",
        input: z.object({}),
        async execute() {
          finished = true;
          return "Done.";
        },
      }),
  } as const;
  const tools = MIA_RUN_TOOLS[ctx.capability].map((name) => all[name as keyof typeof all]());
  return { tools, pending, finished: () => finished };
}

export const sourcesOf = (state: RunState): Map<string, string> => new Map([...(state.inputText === null ? [] : ([[INPUT_SOURCE, state.inputText]] as const)), ...state.pages.map((page) => [page.url, page.text] as const)]);
