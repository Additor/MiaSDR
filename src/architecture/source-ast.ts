import { readFileSync } from "node:fs";
import ts from "typescript";

/** Parses a source file as TSX or TS by its extension, so a `<T>value` assertion in a .ts file reads as one. */
export function parseSource(file: string, text = readFileSync(file, "utf8")): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Visits `node` and every node under it, depth first. */
export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
