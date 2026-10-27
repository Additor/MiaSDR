import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DEFAULT_REPLY_TYPES } from "@/contexts/conversations/domain/default-reply-types";
import { sourceFiles } from "./context-layers";

/**
 * Behavior follows a reply type's rules and `systemRole`, never its key or group ("Reply types and type rules" in
 * docs/decisions.md). The scan reads every conversations layer and `src/app`, and rejects:
 * - a comparison of a group or category key with any string literal (`groupKey === "not_interested"`), also through
 *   `switch` cases;
 * - a comparison of a bare `key` or `replyTypeKey` with a seeded type or group key (`t.key === "other"`);
 * - the string `"do_not_contact"`, the old key of the stop request type, outside `ALLOWED_DNC`;
 * - raw SQL that compares `group_key` with a literal, or `key` with a seeded type or group key (`key <> 'customer'`).
 * Code names the one fixed group with `CUSTOMER_GROUP` and the catch-all type with `CATCH_ALL_TYPE_KEY`.
 * `domain/default-reply-types.ts` holds the seed data and stays out of the scan.
 */

const ROOT = path.resolve(__dirname, "../..");
const BASE = "src/contexts/conversations";
const LAYERS = ["domain", "application", "ai", "after-reply", "actions", "infrastructure"];
const APP = "src/app";
const SKIPPED = new Set([`${BASE}/domain/default-reply-types.ts`]);

/**
 * `"do_not_contact"` literals that are data, per file, with the count the file holds. The contact policy and its
 * blockers share the word with the old type key; they name `contact_policies.do_not_contact`, not a reply type.
 */
const ALLOWED_DNC: Record<string, { count: number; reason: string }> = {
  [`${BASE}/after-reply/domain/sequences.ts`]: { count: 2, reason: "Interrupt reason for a run whose person is marked do not contact." },
  [`${BASE}/after-reply/domain/after-reply.ts`]: { count: 2, reason: "Start blocker for a person marked do not contact." },
  [`${BASE}/application/reply-ports.ts`]: { count: 3, reason: "Send and CC blockers for an address of a person marked do not contact." },
  [`${BASE}/application/linkedin-reply-ports.ts`]: { count: 1, reason: "LinkedIn send blocker for a person marked do not contact." },
  [`${BASE}/ai/infrastructure/fake-reply-ai.ts`]: { count: 1, reason: "The fake model answers with a seeded key, as a real model does." },
  [`${BASE}/infrastructure/drizzle-linkedin-reply-store.ts`]: { count: 1, reason: "LinkedIn send blocker for a person marked do not contact." },
  [`${BASE}/infrastructure/drizzle-reply-handling-store.ts`]: { count: 3, reason: "Stop contacting writes the policy, its run interrupt reason and its enrollment stop reason." },
  [`${BASE}/infrastructure/reply-store-sending.ts`]: { count: 1, reason: "Send blocker for a person marked do not contact." },
  [`${BASE}/infrastructure/reply-store-shared.ts`]: { count: 3, reason: "Blocked address reason for a person marked do not contact." },
  [`${BASE}/infrastructure/schema.ts`]: { count: 1, reason: "Column name of `people.do_not_contact`." },
  ["src/app/(app)/campaigns/[id]/_lib/after-reply-form.ts"]: { count: 1, reason: "Fixed stop of a run whose person is marked do not contact." },
  ["src/app/(app)/crm/_components/create-deal-dialog.tsx"]: { count: 1, reason: "Reach flag for a person marked do not contact." },
  ["src/app/(app)/inbox/[id]/_components/linkedin-reply-panel-client.tsx"]: { count: 1, reason: "Reach flag for a person marked do not contact." },
  ["src/app/(app)/inbox/[id]/_components/reply-composer-client.tsx"]: { count: 1, reason: "Send blocker for an address of a person marked do not contact." },
};

const KEY_NAME = /^(key|replyTypeKey|group_?key|category_?key)$/i;
/** A group or category key compared with any literal is a finding. */
const GROUP_NAME = /^(group|category)_?key$/i;
/**
 * A bare `key` names many things (`event.key`, a sort key), so it is a finding only next to a reply type or group key
 * from the seed set (`demo_request`, `customer`, `other`).
 */
const REPLY_TYPE_WORDS = new Set(DEFAULT_REPLY_TYPES.flatMap((t) => [t.key, t.groupKey]));
const SQL_GROUP_LITERAL = /group_key\s*(=|<>|!=)\s*'|group_key\s+(not\s+)?in\s*\(\s*'/i;

/** Literals a raw SQL text compares a `key` column with (`t.key = 'customer'`, `key in ('a', 'b')`). */
function sqlKeyLiterals(sqlText: string): string[] {
  const out: string[] = [];
  for (const m of sqlText.matchAll(/\bkey\s*(?:=|<>|!=)\s*'([^']*)'|\bkey\s+(?:not\s+)?in\s*\(([^)]*)\)/gi)) {
    if (m[1] !== undefined) out.push(m[1]);
    else for (const w of m[2].matchAll(/'([^']*)'/g)) out.push(w[1]);
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const files = [...LAYERS.map((layer) => path.join(ROOT, BASE, layer)), path.join(ROOT, APP)]
  .flatMap((dir) => sourceFiles(dir))
  .filter((file) => !SKIPPED.has(rel(file)));

/** The last name of an identifier or property access (`a.b.groupKey` → `groupKey`), or null. */
function nameOf(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return nameOf(node.expression);
  return null;
}

const isText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
/** `node` reads a reply type, group or category key and `literal` is a value that key could hold. */
function comparesKey(node: ts.Node, literal: ts.Node): boolean {
  const name = nameOf(node) ?? "";
  if (!KEY_NAME.test(name) || !isText(literal)) return false;
  return GROUP_NAME.test(name) || REPLY_TYPE_WORDS.has(literal.text);
}
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

interface Finding {
  file: string;
  line: number;
  rule: "key comparison" | "do_not_contact" | "sql key literal";
  text: string;
}

function scan(file: string, text = readFileSync(file, "utf8")): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Finding[] = [];
  const add = (node: ts.Node, rule: Finding["rule"]) =>
    out.push({ file: rel(file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule, text: node.getText(source).slice(0, 120) });

  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      const [a, b] = [node.left, node.right];
      if (comparesKey(a, b) || comparesKey(b, a)) add(node, "key comparison");
    }
    if (ts.isSwitchStatement(node) && node.caseBlock.clauses.some((c) => ts.isCaseClause(c) && comparesKey(node.expression, c.expression))) add(node.expression, "key comparison");
    if (isText(node) && node.text === "do_not_contact") add(node, "do_not_contact");
    const sqlText = ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ") : isText(node) ? node.text : null;
    if (sqlText !== null) {
      if (SQL_GROUP_LITERAL.test(sqlText) || sqlKeyLiterals(sqlText).some((word) => REPLY_TYPE_WORDS.has(word))) add(node, "sql key literal");
      if (!isText(node) && /'do_not_contact'/.test(sqlText)) add(node, "do_not_contact");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const findings = files.flatMap((file) => scan(file));

describe("reply type behavior reads rules and roles, not keys", () => {
  it("scans the conversations layers and the app", () => {
    expect(files.length).toBeGreaterThan(30);
    for (const dir of [...LAYERS.map((layer) => `${BASE}/${layer}/`), `${APP}/`]) expect(files.some((file) => rel(file).startsWith(dir)), dir).toBe(true);
    expect(files.map(rel)).toContain(`${BASE}/domain/reply-type.ts`);
  });

  it("compares no group or category key with a literal", () => {
    expect(findings.filter((f) => f.rule === "key comparison")).toEqual([]);
  });

  it("names a group or type key in no raw SQL comparison", () => {
    expect(findings.filter((f) => f.rule === "sql key literal")).toEqual([]);
  });

  it("uses the do_not_contact literal only where it names the contact policy", () => {
    const byFile = new Map<string, number>();
    for (const f of findings.filter((f) => f.rule === "do_not_contact")) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
    const unexpected = [...byFile].filter(([file, count]) => ALLOWED_DNC[file]?.count !== count);
    expect(unexpected, "Use systemRole stop_request, or add the literal to ALLOWED_DNC with its reason and count").toEqual([]);
  });

  it("allows nothing it no longer needs", () => {
    const seen = new Set(findings.filter((f) => f.rule === "do_not_contact").map((f) => f.file));
    expect(Object.keys(ALLOWED_DNC).filter((file) => !seen.has(file))).toEqual([]);
  });

  it("catches each rule on a sample", () => {
    const rules = (text: string) => scan(path.join(ROOT, "sample.ts"), text).map((f) => f.rule);
    expect(rules(`if (record.groupKey === "not_interested") stop();`)).toEqual(["key comparison"]);
    expect(rules(`if ("customer" !== row.group_key) stop();`)).toEqual(["key comparison"]);
    expect(rules(`switch (t.groupKey) { case "other": break; }`)).toEqual(["key comparison"]);
    expect(rules(`if (typeof raw.groupKey === "string") read();`)).toEqual([]);
    expect(rules(`const k = "do_not_contact";`)).toEqual(["do_not_contact"]);
    expect(rules("sql`where r.group_key = 'customer' and x = ${y}`")).toEqual(["sql key literal"]);
    expect(rules("sql`and group_key <> 'not_interested'`")).toEqual(["sql key literal"]);
    expect(rules(`if (t.key === "other") pick();`)).toEqual(["key comparison"]);
    expect(rules(`if (t.replyTypeKey !== "demo_request") pick();`)).toEqual(["key comparison"]);
    expect(rules(`if (row.category_key === "anything") pick();`)).toEqual(["key comparison"]);
    expect(rules(`if (event.key === "Escape") close();`)).toEqual([]);
    expect(rules(`switch (e.key) { case "Enter": break; }`)).toEqual([]);
    expect(rules("sql`where key = 'do_not_contact' and x = ${y}`")).toEqual(["sql key literal", "do_not_contact"]);
    expect(rules("sql`where t.key in ('customer', 'other')`")).toEqual(["sql key literal"]);
    expect(rules("sql`where s.key = 'smtp_host'`")).toEqual([]);
    expect(rules("sql`q.group_key = ${filter.groupKey}`")).toEqual([]);
  });
});
