import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";
import { parseSource, walk } from "./source-ast";

/**
 * A context version bump ends the work prepared for the old version, and one function decides what that covers
 * (`advanceRecordContextTx`). Each path that wrote the column itself chose its own list, and a held pick outlived most
 * of them. Only that file writes `records.context_version`.
 */
const ROOT = path.resolve(__dirname, "../..");
const WRITER = "src/contexts/conversations/infrastructure/record-context.ts";

/** "line" for each write of the version in `text`: a raw update of records, or `.update(records).set({ contextVersion })`. */
function versionWrites(file: string, text: string): number[] {
  const source = parseSource(file, text);
  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;
  const found: number[] = [];
  for (const raw of text.matchAll(/update\s+(?:records|\$\{records\})\b[^`;]*?\bcontext_version\s*=/gi)) found.push(lineOf(raw.index));
  walk(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "set") return;
    const receiver = node.expression.expression;
    const onRecords = ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression) && receiver.expression.name.text === "update" && receiver.arguments[0]?.getText(source) === "records";
    const values = node.arguments[0];
    if (onRecords && values && ts.isObjectLiteralExpression(values) && values.properties.some((p) => p.name?.getText(source) === "contextVersion")) found.push(lineOf(node.getStart(source)));
  });
  return found;
}

describe("the writer of records.context_version", () => {
  it("is record-context.ts alone", () => {
    const files = [...sourceFiles(path.join(ROOT, "src/contexts")), ...sourceFiles(path.join(ROOT, "src/platform")), ...sourceFiles(path.join(ROOT, "src/read-models")), ...sourceFiles(path.join(ROOT, "src/app"))];
    const writes = files.flatMap((file) => versionWrites(file, readFileSync(file, "utf8")).map((line) => `${path.relative(ROOT, file)}:${line}`));
    expect(writes.filter((w) => !w.startsWith(`${WRITER}:`))).toEqual([]);
    expect(writes.filter((w) => w.startsWith(`${WRITER}:`))).toHaveLength(1);
  });

  it("finds the shapes a write takes", () => {
    const sample = (body: string) => versionWrites("sample.ts", body).length;
    expect(sample("await tx.update(records).set({ contextVersion: version }).where(x);")).toBe(1);
    expect(sample("await tx.execute(sql`update records set context_version = context_version + 1 where id = ${id}`);")).toBe(1);
    expect(sample("await tx.execute(sql`update records set\n  workflow_state = ${s},\n  context_version = context_version + 1`);")).toBe(1);
    expect(sample("await tx.insert(events).values({ contextVersion: version });")).toBe(0);
    expect(sample("await tx.update(drafts).set({ contextVersion: version });")).toBe(0);
  });
});
