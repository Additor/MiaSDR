import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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

/** The module specifiers a source loads at run time: imports and re-exports that are not type-only, `import()` and `require()`. */
export function runtimeSpecifiers(file: string, text: string): string[] {
  const found: string[] = [];
  walk(parseSource(file, text), (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
      const typeOnly = clause?.isTypeOnly || (clause && !clause.name && named && named.length > 0 && named.every((e) => e.isTypeOnly));
      if (!typeOnly) found.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const loads = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (loads) found.push(node.arguments[0].text);
    }
  });
  return found;
}

/** How an import walk reads files, by repo-relative posix path: their text, and whether one exists. A test hands in sample files. */
export interface SourceReader {
  read(file: string): string;
  exists(file: string): boolean;
}

const ROOT = path.resolve(__dirname, "../..");

/** The repository on disk. */
export const disk: SourceReader = {
  read: (file) => readFileSync(path.join(ROOT, file), "utf8"),
  exists: (file) => existsSync(path.join(ROOT, file)) && statSync(path.join(ROOT, file)).isFile(),
};

/** A specifier as a src file (`@/x` or relative), or null for a package or a file that does not exist. */
export function resolveSource(from: string, specifier: string, reader: SourceReader): string | null {
  const base = specifier.startsWith("@/") ? `src/${specifier.slice(2)}` : specifier.startsWith(".") ? path.posix.join(path.posix.dirname(from), specifier) : null;
  if (!base) return null;
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => /\.tsx?$/.test(candidate) && reader.exists(candidate)) ?? null;
}

const parsed = new WeakMap<SourceReader, Map<string, string[]>>();

/** `runtimeSpecifiers` of a file, parsed once per reader. */
export function specifiersOf(file: string, reader: SourceReader): string[] {
  if (!parsed.has(reader)) parsed.set(reader, new Map());
  const known = parsed.get(reader)!;
  if (!known.has(file)) known.set(file, runtimeSpecifiers(file, reader.read(file)));
  return known.get(file)!;
}
