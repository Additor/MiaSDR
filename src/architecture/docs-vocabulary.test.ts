import { readFileSync } from "node:fs";
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
