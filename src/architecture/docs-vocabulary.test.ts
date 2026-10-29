import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** Terms "Leads and CRM" in docs/decisions.md adds to the PRODUCT.md Terminology list. */
const TERMS = ["Lead", "Contact", "Company", "Deal", "Stage"];

/** Terms "Contacts and Companies CRUD" in docs/decisions.md adds to that list. */
const CRUD_TERMS = ["Other domains", "Listed in Companies", "Make contact"];

/** Terms the UI shows whose code names differ (`record`, `grid`, `waterfall`), and the map of names that stay. */
const CODE_NAME_TERMS = ["Conversation", "Tables", "Workbook", "Table", "Enrichment column", "Enrichment provider", "Code names"];

/** Terms "Reply types and type rules" in docs/decisions.md adds to that list. */
const REPLY_TYPE_TERMS = [
  "Reply type",
  "Group",
  "Type rules",
  "Confidence floor",
  "AI pick",
  "Asked to stop",
  "Customer question",
  "Existing customer",
  "Looks right",
  "Review stop request",
  "Change type",
  "Remind me",
  "Follow-ups after a reply",
];

/** Words the Terminology list no longer defines, because the screens no longer show them. */
const RETIRED_TERMS = ["Reply category", "Subcategory", "After a reply", "Classification"];

/** The Terminology section of PRODUCT.md, up to the next level-2 heading. */
function terminology(): string {
  const text = read("PRODUCT.md");
  const start = text.indexOf("## Terminology");
  expect(start, "PRODUCT.md has no Terminology section").toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + "## Terminology".length);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("product vocabulary", () => {
  it.each([...TERMS, ...CRUD_TERMS, ...CODE_NAME_TERMS, ...REPLY_TYPE_TERMS])("defines %s in the PRODUCT.md Terminology list", (term) => {
    // A list item that starts with the bold term followed by a colon: "- **Lead:** ..."
    expect(terminology()).toMatch(new RegExp(`^- \\*\\*${term}:\\*\\*`, "m"));
  });

  it.each(RETIRED_TERMS)("no longer defines %s", (term) => {
    expect(terminology()).not.toMatch(new RegExp(`^- \\*\\*${term}:\\*\\*`, "m"));
  });
});

/** Docs that describe the screens. PRODUCT.md is guarded by its Terminology list above. */
const SCREEN_DOCS = [
  "docs/decisions.md",
  "docs/operations.md",
  "DESIGN.md",
  "README.md",
  ...readdirSync(join(root, "docs/guides")).filter((f) => f.endsWith(".md")).map((f) => `docs/guides/${f}`),
  ...readdirSync(join(root, "docs/design")).filter((f) => f.endsWith(".md")).map((f) => `docs/design/${f}`),
];

/**
 * Screen names the UI retired, as a doc would use them. Code names in backticks stay (`subcategoryKey`,
 * `after-reply`), and so does "Follow-ups after a reply", whose lowercase words the case-sensitive rules leave alone.
 */
const RETIRED_DOC_WORDS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "Reply category", pattern: /\breply categor(y|ies)\b/i },
  { name: "Subcategory", pattern: /\bsub-?categor(y|ies)\b/i },
  { name: "Classification card", pattern: /\bclassification card\b/i },
  { name: "Classification as a screen name", pattern: /\bClassifications?\b/ },
  { name: "After a reply as a setting name", pattern: /\bAfter a reply\b/ },
  { name: "Position as a reply type field", pattern: /\bPosition\b/ },
  { name: "Waiting on as the thread line", pattern: /\bWaiting on\b/ },
];

/** A doc's prose: fenced blocks and inline code left out, so code names in backticks pass. */
const prose = (text: string) => text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

function retiredWords(file: string, text: string): string[] {
  return prose(text)
    .split("\n")
    .flatMap((line, i) => RETIRED_DOC_WORDS.filter((w) => w.pattern.test(line)).map((w) => `${file}:${i + 1} [${w.name}] ${line.trim().slice(0, 120)}`));
}

describe("retired screen names in the docs", () => {
  it("reads the docs that describe the screens", () => {
    expect(SCREEN_DOCS).toContain("docs/guides/how-it-works.md");
    expect(SCREEN_DOCS).toContain("DESIGN.md");
    expect(SCREEN_DOCS).toContain("docs/design/inbox-and-actions.md");
  });

  it.each(SCREEN_DOCS)("%s uses no retired screen name", (file) => {
    expect(retiredWords(file, read(file))).toEqual([]);
  });

  it("catches each word on a sample and lets code names pass", () => {
    const hits = (text: string) => retiredWords("sample.md", text).length;
    expect(hits("Open the Reply category menu.")).toBe(1);
    expect(hits("Pick a subcategory.")).toBe(1);
    expect(hits("The classification card shows it.")).toBe(1);
    expect(hits("Turn on After a reply.")).toBe(1);
    expect(hits("Set the Position of the type.")).toBe(1);
    expect(hits("Waiting on them since Monday.")).toBe(1);
    expect(hits("Follow-ups after a reply, `after-reply`, `subcategoryKey`, the job kind `classification`.")).toBe(0);
  });
});
