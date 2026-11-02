/**
 * MCP Apps cards: small pages a host that supports them shows in the chat beside a tool's answer. A host that does not
 * ignores them and the agent reads the same answer as text. Each card reads the tool's answer and only displays it: nothing
 * here sends or changes anything, and its one action opens MiaSDR, where a person reviews and sends.
 *
 * The answer carries a stranger's text, so the script builds the page with `textContent` alone and never parses that
 * text as HTML. The pages load nothing, so the host's default policy of no network access fits them.
 */

export const CARD_MIME_TYPE = "text/html;profile=mcp-app";
/** The MCP Apps extension, named in the server's capabilities. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
/** The MCP Apps protocol version these pages speak to their host. */
const APPS_PROTOCOL = "2026-01-26";

export const DRAFT_CARD_URI = "ui://miasdr/reply-draft.html";
export const LAUNCH_CARD_URI = "ui://miasdr/campaign-launch.html";

/** The host's protocol, a shared helper set and the error view. `render` then draws one tool's answer. */
const RUNTIME = String.raw`
const APPS_PROTOCOL = ${JSON.stringify(APPS_PROTOCOL)};
let nextId = 1;
const waiting = new Map();
const post = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  waiting.set(id, { resolve, reject });
  post({ id, method, params });
});
const FENCE = /<\/?untrusted_[a-z]+_[0-9a-f]+>\n?/g;
const plain = (text) => String(text ?? "").replace(FENCE, "").trim();
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}
const row = (label, value) => el("div", "row", el("span", "label", label), el("span", "", String(value)));
const openButton = (label, url) => {
  const button = el("button", "open", label);
  button.type = "button";
  button.addEventListener("click", () => request("ui/open-link", { url }).catch(() => {}));
  return button;
};
function show(...nodes) {
  document.getElementById("card").replaceChildren(...nodes);
}
function applyTheme(context) {
  if (!context) return;
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) if (value) document.documentElement.style.setProperty(name, value);
}
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.id !== undefined && !message.method) {
    const call = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) call?.reject(message.error);
    else call?.resolve(message.result);
    return;
  }
  if (message.method === "ui/notifications/host-context-changed") applyTheme(message.params);
  if (message.method === "ui/notifications/tool-result") {
    const { structuredContent: answer, isError, content } = message.params ?? {};
    if (isError || answer?.error) show(el("p", "problem", plain(answer?.error?.message ?? content?.[0]?.text ?? "The tool could not answer.")));
    else render(answer ?? {});
  }
  if (message.method === "ui/notifications/tool-cancelled") show(el("p", "muted", "The call was cancelled."));
  if (message.method === "ui/resource-teardown" && message.id !== undefined) post({ id: message.id, result: {} });
});
new ResizeObserver(() => post({ method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } })).observe(document.documentElement);
request("ui/initialize", { protocolVersion: APPS_PROTOCOL, appInfo: { name: "miasdr", version: "1" }, appCapabilities: {} }).then((result) => {
  applyTheme(result?.hostContext);
  post({ method: "ui/notifications/initialized" });
});
`;

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 14px 16px; font: 14px/1.5 var(--font-sans, system-ui, sans-serif); color: var(--color-text-primary, CanvasText); background: var(--color-background-primary, transparent); }
h1 { margin: 0; font-size: 14px; font-weight: 600; }
p { margin: 0; }
.head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 10px; }
.muted, .label { color: var(--color-text-secondary, GrayText); }
.subject { font-weight: 600; margin-bottom: 4px; }
.body { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow-y: auto; padding: 10px 12px; border: 1px solid var(--color-border-primary, color-mix(in srgb, CanvasText 18%, transparent)); border-radius: 8px; }
.problem { color: var(--color-text-danger, light-dark(#b42318, #f97066)); }
ul { margin: 0 0 10px; padding-left: 18px; }
.row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
.rows { margin-bottom: 10px; }
.foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 12px; }
.open { font: inherit; padding: 5px 12px; border-radius: 6px; cursor: pointer; color: inherit; background: transparent; border: 1px solid var(--color-border-primary, color-mix(in srgb, CanvasText 30%, transparent)); }
.open:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
`;

const page = (title: string, render: string) =>
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${STYLE}</style></head>
<body><main id="card"><p class="muted">Loading…</p></main><script>${RUNTIME}${render}</script></body>
</html>`;

const DRAFT_RENDER = String.raw`
function render(answer) {
  const draft = answer.draft;
  if (!draft) return show(el("p", "muted", "This conversation has no open draft."), answer.reviewUrl ? el("div", "foot", el("span"), openButton("Open in MiaSDR", answer.reviewUrl)) : null);
  show(
    el("div", "head", el("h1", "", "Reply draft"), el("span", "muted", draft.status.replaceAll("_", " "))),
    draft.subject ? el("p", "subject", plain(draft.subject)) : null,
    el("div", "body", plain(draft.text)),
    el("div", "foot", el("span", "muted", [draft.truncated ? "Cut to fit here." : "", draft.status === "awaiting_review" ? "Nothing has been sent." : ""].join(" ").trim()), openButton("Review in MiaSDR", answer.reviewUrl)),
  );
}
`;

const LAUNCH_RENDER = String.raw`
const ACTION = { start: "Start campaign", resume: "Resume campaign", enroll: "Add leads to campaign" };
function render(answer) {
  const problems = answer.problems ?? [];
  const senders = answer.senders ?? [];
  const step = answer.firstStep ?? {};
  show(
    el("div", "head", el("h1", "", ACTION[answer.purpose] ?? "Campaign launch"), el("span", "muted", answer.status)),
    problems.length > 0 ? el("ul", "problem", ...problems.map((p) => el("li", "", p))) : el("p", "muted", "Nothing stops it."),
    el(
      "div",
      "rows",
      row("Leads waiting", answer.pendingLeads),
      row(senders.length === 1 ? "Sender" : "Senders", answer.allAccounts ? "Every connected account" : senders.map((s) => s.name).join(", ") || "None"),
      row("Agent enrolls left today", answer.agentEnrollsLeftToday),
      answer.estimatedDays === null || answer.estimatedDays === undefined ? null : row("Days to invite them", answer.estimatedDays),
      answer.emptySubjectLeads ? row("Sampled leads with an empty subject", answer.emptySubjectLeads) : null,
    ),
    step.bodyText ? el("p", "label", step.leadName ? "Step 1 for " + step.leadName : "Step 1") : null,
    step.subject ? el("p", "subject", plain(step.subject)) : null,
    step.bodyText ? el("div", "body", plain(step.bodyText)) : null,
    el("div", "foot", el("span", "muted", "This preview starts nothing."), openButton("Open in MiaSDR", answer.appUrl)),
  );
}
`;

/** Every card, by the URI a tool's `card` names. */
export const CARDS: Record<string, { name: string; description: string; html: string }> = {
  [DRAFT_CARD_URI]: { name: "Reply draft", description: "The reply draft a person reviews, with a link to send it from MiaSDR.", html: page("Reply draft", DRAFT_RENDER) },
  [LAUNCH_CARD_URI]: { name: "Campaign launch", description: "What starting a campaign would do: its problems, senders, waiting leads and first step.", html: page("Campaign launch", LAUNCH_RENDER) },
};
