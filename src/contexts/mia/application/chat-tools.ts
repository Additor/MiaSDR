import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AgentTool } from "@/contexts/ai/application/agent-ports";
import { fence } from "@/contexts/ai/domain/prompt-fence";
import { BRAIN_KINDS, type BrainKind } from "@/contexts/brain/domain/brain-kinds";
import { isUuid } from "@/shared/uuid";
import { CHAT_TOOL_ROWS, CHAT_TOOL_TEXT, MIA_CHAT_TOOLS, type ChatLink, type ChatPart, type MiaChatTool } from "../domain/mia-chat";
import type { ChatPersonRow, ClaimedTurn, MiaChatReads, MiaChatStore } from "./chat-ports";

const nonce = () => randomBytes(6).toString("hex");

const clip = (text: string | null, max = CHAT_TOOL_TEXT) => (text === null ? null : text.length <= max ? text : `${text.slice(0, max)}…`);

/** Custom fields as one short JSON text: they can be anything a person or an import wrote. */
const clipJson = (value: Record<string, unknown>) => clip(JSON.stringify(value), 2_000);

const personPath = (p: Pick<ChatPersonRow, "id" | "lifecycle">) => (p.lifecycle === "contact" ? `/crm/contacts/${p.id}` : `/leads/${p.id}`);

const personLink = (p: ChatPersonRow): ChatLink => ({ href: personPath(p), label: p.name ?? "Unnamed person" });

const personRow = (p: ChatPersonRow) => ({ id: p.id, path: personPath(p), name: p.name, title: p.title, company: p.company, lifecycle: p.lifecycle });

interface ChatToolContext {
  turn: ClaimedTurn;
  reads: MiaChatReads;
  store: Pick<MiaChatStore, "linkPeople">;
  /** Gets each call's part as it ends, so the answer can show what Mia read. */
  onPart: (part: Extract<ChatPart, { type: "tool" }>) => void;
}

const NOT_FOUND = "Not found. It may have been deleted, or the id is wrong.";

/**
 * The tools of one turn. Each reads, and none writes: a reply that tells Mia to send, change or delete has no tool to do
 * it with. A tool links every person it read to the chat before their data reaches the model, so deleting that person
 * later deletes what Mia said about them. Results go back inside a fence, since much of what they hold was written by
 * the people in them.
 */
export function chatTools(ctx: ChatToolContext): AgentTool<never>[] {
  const { turn, reads } = ctx;
  const org = turn.organizationId;

  /** Links these people and answers with the ones that still exist. */
  const linked = async (ids: readonly string[]) => (ids.length === 0 ? new Set<string>() : ctx.store.linkPeople(turn, ids));

  const define = <I,>(name: MiaChatTool, description: string, input: z.ZodType<I>, run: (input: I) => Promise<{ data: unknown; links: ChatLink[] }>): AgentTool<never> =>
    ({
      name,
      description,
      input,
      async execute(value: I) {
        try {
          const { data, links } = await run(value);
          ctx.onPart({ type: "tool", name, failed: false, links });
          return fence("tool_result", JSON.stringify(data), nonce());
        } catch (error) {
          ctx.onPart({ type: "tool", name, failed: true, links: [] });
          throw error;
        }
      },
    }) as unknown as AgentTool<never>;

  const id = z.string().describe("An id from an earlier result.");
  const needId = (value: string) => {
    if (!isUuid(value)) throw new Error(NOT_FOUND);
    return value;
  };

  const tools: Record<MiaChatTool, AgentTool<never>> = {
    search_leads: define(
      "search_leads",
      "Finds leads and contacts by name, email, title or company. Returns up to 10.",
      z.object({ query: z.string().max(200) }),
      async ({ query }) => {
        const rows = await reads.searchPeople(org, query.trim(), CHAT_TOOL_ROWS);
        const kept = await linked(rows.map((r) => r.id));
        const people = rows.filter((r) => kept.has(r.id));
        return { data: { people: people.map(personRow) }, links: people.map(personLink) };
      },
    ),

    read_lead: define("read_lead", "Reads one lead or contact: profile, company and custom fields.", z.object({ id }), async (input) => {
      const personId = needId(input.id);
      if (!(await linked([personId])).has(personId)) throw new Error(NOT_FOUND);
      const p = await reads.person(org, personId);
      if (!p) throw new Error(NOT_FOUND);
      const data = {
        ...personRow(p),
        email: p.email,
        linkedinUrl: p.linkedinUrl,
        companyId: p.companyId,
        companyPath: p.companyId ? `/crm/companies/${p.companyId}` : null,
        companyDomain: p.companyDomain,
        custom: clipJson(p.custom),
        createdAt: p.createdAt.toISOString(),
      };
      return { data, links: [personLink(p)] };
    }),

    read_company: define("read_company", "Reads one company and up to 10 of its people.", z.object({ id }), async (input) => {
      const company = await reads.company(org, needId(input.id));
      if (!company) throw new Error(NOT_FOUND);
      const kept = await linked(company.people.map((p) => p.id));
      const people = company.people.filter((p) => kept.has(p.id));
      const path = `/crm/companies/${company.id}`;
      return { data: { id: company.id, path, name: company.name, domain: company.domain, custom: clipJson(company.custom), people: people.map(personRow) }, links: [{ href: path, label: company.name ?? company.domain }] };
    }),

    read_conversation: define("read_conversation", "Reads the latest messages with one lead or contact, newest first.", z.object({ personId: id }), async (input) => {
      const personId = needId(input.personId);
      if (!(await linked([personId])).has(personId)) throw new Error(NOT_FOUND);
      const conversation = await reads.conversation(org, personId, CHAT_TOOL_ROWS);
      const messages = conversation.messages.map((m) => ({ direction: m.direction === "inbound" ? "from_them" : "from_us", channel: m.channel, sentAt: m.sentAt.toISOString(), subject: clip(m.subject, 300), text: clip(m.text, 1_500) }));
      const links = conversation.threadIds.slice(0, 3).map((threadId) => ({ href: `/inbox/${threadId}`, label: "Conversation" }));
      return { data: { inboxPaths: links.map((l) => l.href), messages }, links };
    }),

    read_fit: define("read_fit", "Reads Mia's latest fit check of one lead: the verdict and each criterion with its evidence.", z.object({ personId: id }), async (input) => {
      const personId = needId(input.personId);
      if (!(await linked([personId])).has(personId)) throw new Error(NOT_FOUND);
      const fit = await reads.fit(org, personId);
      if (!fit) return { data: { checked: false }, links: [] };
      return { data: { checked: true, verdict: fit.verdict, criteria: fit.criteria, missing: fit.missing, assessedAt: fit.assessedAt.toISOString() }, links: [] };
    }),

    list_brain_items: define(
      "list_brain_items",
      "Lists active Brain items by title, of one kind or all.",
      z.object({ kind: z.enum(BRAIN_KINDS as unknown as [BrainKind, ...BrainKind[]]).optional() }),
      async ({ kind }) => {
        const items = await reads.brainItems(org, kind ?? null, 50);
        return { data: { items: items.map((i) => ({ ...i, path: `/brain/${i.id}` })) }, links: [{ href: "/brain", label: "Brain" }] };
      },
    ),

    read_brain_item: define("read_brain_item", "Reads one Brain item.", z.object({ id }), async (input) => {
      const item = await reads.brainItem(org, needId(input.id));
      if (!item) throw new Error(NOT_FOUND);
      const path = `/brain/${item.id}`;
      return { data: { id: item.id, path, kind: item.kind, title: item.title, text: clip(item.text) }, links: [{ href: path, label: item.title }] };
    }),
  };

  return MIA_CHAT_TOOLS.map((name) => tools[name]);
}
