import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";

/**
 * Behavior follows a reply type's rules and `systemRole`, never its key or group ("Reply types and type rules" in
 * docs/decisions.md). The scan reads the conversations layers that decide what a reply does and rejects:
 * - a comparison of a group or category key with a string literal (`groupKey === "not_interested"`), also through
 *   `switch` cases;
 * - the string `"do_not_contact"`, the old key of the stop request type;
 * - raw SQL that compares `group_key` with a literal (`group_key = 'customer'`, `group_key <> '...'`, `group_key in ('...')`).
 * `domain/reply-type.ts` and `domain/default-reply-types.ts` hold the seed data and stay out of the scan.
 */

const ROOT = path.resolve(__dirname, "../..");
const BASE = "src/contexts/conversations";
const LAYERS = ["domain", "application", "ai", "after-reply", "actions"];
const SKIPPED = new Set([`${BASE}/domain/reply-type.ts`, `${BASE}/domain/default-reply-types.ts`]);

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
};

const KEY_NAME = /^(group|category)_?key$/i;
const SQL_GROUP_LITERAL = /group_key\s*(=|<>|!=)\s*'|group_key\s+(not\s+)?in\s*\(\s*'/i;

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const files = LAYERS.flatMap((layer) => sourceFiles(path.join(ROOT, BASE, layer))).filter((file) => !SKIPPED.has(rel(file)));

/** The last name of an identifier or property access (`a.b.groupKey` → `groupKey`), or null. */
function nameOf(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return nameOf(node.expression);
  return null;
}

const isKey = (node: ts.Node) => KEY_NAME.test(nameOf(node) ?? "");
const isText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

interface Finding {
  file: string;
  line: number;
  rule: "key comparison" | "do_not_contact" | "sql group literal";
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
      if ((isKey(a) && isText(b)) || (isText(a) && isKey(b))) add(node, "key comparison");
    }
    if (ts.isSwitchStatement(node) && isKey(node.expression) && node.caseBlock.clauses.some((c) => ts.isCaseClause(c) && isText(c.expression))) add(node.expression, "key comparison");
    if (isText(node) && node.text === "do_not_contact") add(node, "do_not_contact");
    const sqlText = ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ") : isText(node) ? node.text : null;
    if (sqlText !== null) {
      if (SQL_GROUP_LITERAL.test(sqlText)) add(node, "sql group literal");
      if (!isText(node) && /'do_not_contact'/.test(sqlText)) add(node, "do_not_contact");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const findings = files.flatMap((file) => scan(file));

describe("reply type behavior reads rules and roles, not keys", () => {
  it("scans the conversations layers", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it("compares no group or category key with a literal", () => {
    expect(findings.filter((f) => f.rule === "key comparison")).toEqual([]);
  });

  it("names a group in no raw SQL comparison", () => {
    expect(findings.filter((f) => f.rule === "sql group literal")).toEqual([]);
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
    expect(rules("sql`where r.group_key = 'customer' and x = ${y}`")).toEqual(["sql group literal"]);
    expect(rules("sql`and group_key <> 'not_interested'`")).toEqual(["sql group literal"]);
    expect(rules("sql`where key = 'do_not_contact' and x = ${y}`")).toEqual(["do_not_contact"]);
    expect(rules("sql`q.group_key = ${filter.groupKey}`")).toEqual([]);
  });
});
