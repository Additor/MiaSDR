import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

/** Terms "Leads and CRM" in docs/decisions.md adds to the PRODUCT.md Terminology list. */
const TERMS = ["Lead", "Contact", "Company", "Deal", "Stage"];

/** Terms "Contacts and Companies CRUD" in docs/decisions.md adds to that list. */
const CRUD_TERMS = ["Other domains", "Listed in Companies", "Make contact"];

/** Terms the UI shows whose code names differ (`conversation`, `grid`, `waterfall`), and the map of names that stay. */
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
  "Review stop request",
  "Change type",
  "Remind me",
  "Follow-ups after a reply",
];

/** Words the Terminology list no longer defines, because the screens no longer show them. */
const RETIRED_TERMS = ["Reply category", "Subcategory", "Category", "Unclassified", "After a reply", "Classification", "Formula", "Personal campaign", "Looks right", "Check", "Checks", "Record"];

/** The words those terms left behind in `src/contexts/conversations`, comments and tests included, as code and prose would write them. */
const RETIRED_IN_CONVERSATIONS: ReadonlyArray<{ name: string; pattern: RegExp; except?: RegExp }> = [
  { name: "subcategory", pattern: /sub-?categor(y|ies)/i },
  { name: "category", pattern: /\bcategor(y|ies)\b/i },
  { name: "pipeline", pattern: /pipeline/i },
  { name: "the record", pattern: /\b(the|a|another|closed|each|every|per-) record\b/i },
  // The draft prompt's text is on the copy-vocabulary allowlist, because a wording change needs a draft eval.
  { name: "stage outside deals", pattern: /(?<!deal )\bstages?\b/i, except: /\/ai\/domain\/prompts(\.test)?\.ts$/ },
  { name: "conversation's conversation", pattern: /conversation's conversation/i },
  { name: "legacy standalone", pattern: /legacy standalone/i },
];

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

function sourceTree(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceTree(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("retired words in src/contexts/conversations", () => {
  it("stay out", () => {
    const hits = sourceTree("src/contexts/conversations").flatMap((file) =>
      read(file)
        .split("\n")
        .flatMap((line, i) => RETIRED_IN_CONVERSATIONS.filter((w) => w.pattern.test(line) && !w.except?.test(file)).map((w) => `${file}:${i + 1} [${w.name}] ${line.trim().slice(0, 120)}`)),
    );
    expect(hits).toEqual([]);
  });
});

/**
 * Words that left the whole product, in code, tests and comments alike. A campaign's Sequence stays, and raw provider
 * fields keep their own names: the `except` entries are a Unipile parameter and a spec that asserts the old words are gone.
 */
const RETIRED_EVERYWHERE: ReadonlyArray<{ name: string; pattern: RegExp; except?: RegExp }> = [
  { name: "unclassified", pattern: /\bunclassified\b/i },
  { name: "subcategory", pattern: /sub-?categor(y|ies)/i, except: /^e2e\/46-reply-handling-settings\.spec\.ts$/ },
  { name: "category", pattern: /\bcategor(y|ies)\b/i, except: /unipile-standin\.ts$|^e2e\/46-reply-handling-settings\.spec\.ts$/ },
  { name: "sequence event token", pattern: /["'`]sequence\.[a-z_]+/ },
  { name: "scheduled kind sequence", pattern: /kind: "sequence"|'sequence'::text/ },
  { name: "follow-up as a sequence", pattern: /follow-up sequence|sequence runs?\b|sequence_changed/i },
  { name: "deal stage event under the reply type's name", pattern: /deal\.type_changed/ },
  { name: "a conversation as a record", pattern: /\b(CRM|reply|reply-handling) records?\b|\brecord-bound\b|\bid: record\b|\[record\]/ },
  { name: "queue group classification", pattern: /queue-total-classification|groups\.classification\b/ },
];

/** This file and the other vocabulary guard name the words they retire. */
const GUARD_FILES = /^src\/architecture\/(docs|copy)-vocabulary\.test\.ts$/;

function retiredEverywhere(file: string, text: string): string[] {
  return text
    .split("\n")
    .flatMap((line, i) => RETIRED_EVERYWHERE.filter((w) => w.pattern.test(line) && !w.except?.test(file)).map((w) => `${file}:${i + 1} [${w.name}] ${line.trim().slice(0, 120)}`));
}

describe("retired words across src and e2e", () => {
  it("stay out", () => {
    const hits = [...sourceTree("src"), ...sourceTree("e2e")].filter((file) => !GUARD_FILES.test(file)).flatMap((file) => retiredEverywhere(file, read(file)));
    expect(hits).toEqual([]);
  });

  it("catches each word on a sample and leaves a campaign's Sequence and the word record alone", () => {
    const hits = (text: string) => retiredEverywhere("sample.ts", text).length;
    for (const sample of ["unclassified: 1", "subcategory: null", "?category=interested", '"sequence.started"', 'kind: "sequence"', "The follow-up sequence ended.", '"deal.type_changed"', "a CRM record", "const [{ id: record }] = rows"]) {
      expect(hits(sample), sample).toBe(1);
    }
    for (const sample of ['source: "sequence"', "in_sequence", "The sequence stops for that lead.", "audit.record(entry)", "z.record(z.string(), z.number())", "records the event"]) {
      expect(hits(sample), sample).toBe(0);
    }
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
 * Screen names the UI retired, as a doc would use them. Code names in backticks stay (`replyTypeKey`,
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
    expect(hits("Follow-ups after a reply, `after-reply`, `replyTypeKey`, the job kind `classification`.")).toBe(0);
  });
});
