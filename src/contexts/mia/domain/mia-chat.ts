/**
 * Mia's chat: a person asks, Mia reads leads, conversations and Brain through read-only tools and answers. Nothing it
 * says changes anything: it has no tool that writes, sends or opens the web. "Mia chat" in docs/decisions.md.
 */

/** The tools a chat may call. The architecture test pins this list beside `MIA_RUN_TOOLS`: each name is a decision about what a chat can read. */
export const MIA_CHAT_TOOLS = ["search_leads", "read_lead", "read_company", "read_conversation", "read_fit", "list_brain_items", "read_brain_item"] as const;
export type MiaChatTool = (typeof MIA_CHAT_TOOLS)[number];

export const MIA_MESSAGE_ROLES = ["user", "assistant"] as const;
export type MiaMessageRole = (typeof MIA_MESSAGE_ROLES)[number];

/** `interrupted` is an answer whose turn ended without it: a restart, or a crash. */
export const MIA_MESSAGE_STATUSES = ["streaming", "complete", "stopped", "failed", "interrupted"] as const;
export type MiaMessageStatus = (typeof MIA_MESSAGE_STATUSES)[number];

export const CHAT_MESSAGE_CHARS = 8_000;
export const CHAT_MAX_STEPS = 6;
export const CHAT_TURN_TOKENS = 60_000;
export const CHAT_TIMEOUT_MS = 120_000;
export const CHAT_TURNS_PER_HOUR = 30;
/** The earlier messages a turn sends, as text: tool results of earlier turns are not stored, so they are not sent again. */
export const CHAT_HISTORY = 20;
/** A turn that has not saved for this long is taken to be dead, so the next question may take its place. */
export const TURN_STALE_MS = 3 * 60_000;
/** How often a streaming answer is saved, so a reload shows most of it. */
export const CHAT_SAVE_MS = 2_000;
export const CHAT_TITLE_CHARS = 60;
export const CHAT_THREADS_PAGE = 50;
export const CHAT_TOOL_ROWS = 10;
/** The longest text one tool result holds per field: a Brain item, a message. */
export const CHAT_TOOL_TEXT = 4_000;

/** A link the answer may show. Every one points into the app, at a page the server built from an id it read. */
export interface ChatLink {
  href: string;
  label: string;
}

/** What a stored message holds. A tool part keeps its name and links, never what the tool returned. */
export type ChatPart = { type: "text"; text: string } | { type: "tool"; name: MiaChatTool; failed: boolean; links: ChatLink[] };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const APP_PATHS = [new RegExp(`^/(leads|crm/contacts|crm/companies|inbox|brain)/${UUID}$`, "i"), /^\/brain$/];

/**
 * The only addresses an answer can link to. An answer that a reply steered still cannot send a person, or what they
 * read, anywhere outside the app: an image or an outside link would carry data out in its address.
 */
export const isAppLink = (href: string): boolean => APP_PATHS.some((path) => path.test(href));

/** A chat's name from its first question. */
export function threadTitle(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length <= CHAT_TITLE_CHARS ? line : `${line.slice(0, CHAT_TITLE_CHARS - 1).trimEnd()}…`;
}

/** The text of a message, its tool parts left out. */
export const partsText = (parts: readonly ChatPart[]): string =>
  parts
    .filter((p): p is Extract<ChatPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

/** What a tool part says it did, for the folded line under an answer. */
export const TOOL_LABELS: Record<MiaChatTool, string> = {
  search_leads: "Searched leads",
  read_lead: "Read a lead",
  read_company: "Read a company",
  read_conversation: "Read a conversation",
  read_fit: "Read a fit check",
  list_brain_items: "Listed Brain items",
  read_brain_item: "Read a Brain item",
};

/** One line of the answer stream a turn request sends. `duplicate` ends the stream of a question sent twice. */
export type ChatTurnEvent =
  | { type: "start"; answerId: string; started: boolean }
  | { type: "text"; delta: string }
  | { type: "tool"; part: Extract<ChatPart, { type: "tool" }> }
  | { type: "end"; status: MiaMessageStatus | "duplicate"; error: string | null };

/** A message as a person sees it: an answer whose turn died shows as interrupted, whatever its row still says. */
export function shownStatus(message: { status: MiaMessageStatus; updatedAt: Date }, now: Date): MiaMessageStatus {
  return message.status === "streaming" && now.getTime() - message.updatedAt.getTime() > TURN_STALE_MS ? "interrupted" : message.status;
}
