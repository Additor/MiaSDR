import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseSource, walk } from "./source-ast";

/**
 * The MCP server uses the v2 SDK, `@modelcontextprotocol/server`, which resolves the app's zod 4. The v1 package
 * `@modelcontextprotocol/sdk` is still in the lockfile through the shadcn CLI and pins zod 3; a file that loads it
 * would mix two zod copies. Type imports count too, since v1 and v2 types differ.
 */

const ROOT = path.resolve(__dirname, "../..");
const V1 = /^@modelcontextprotocol\/sdk(\/|$)/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Every module specifier a source names, type-only imports included. */
export function allSpecifiers(file: string, text: string): string[] {
  const found: string[] = [];
  walk(parseSource(file, text), (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const loads = node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (loads) found.push(node.arguments[0].text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.push(node.argument.literal.text);
    }
  });
  return found;
}

describe("MCP SDK version", () => {
  it("finds v1 imports of every kind in a sample", () => {
    const sample = [
      `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`,
      `import type { Tool } from "@modelcontextprotocol/sdk/types.js";`,
      `export * from "@modelcontextprotocol/sdk";`,
      `const m = await import("@modelcontextprotocol/sdk/client");`,
      `type T = import("@modelcontextprotocol/sdk/types.js").Tool;`,
      `import { createMcpHandler } from "@modelcontextprotocol/server";`,
    ].join("\n");
    expect(allSpecifiers("sample.ts", sample).filter((s) => V1.test(s))).toHaveLength(5);
  });

  it("loads no part of the v1 SDK from src", () => {
    // Only a file that names the package can load it, so the AST parse runs on those alone.
    const offenders = sourceFiles(path.join(ROOT, "src")).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      if (!text.includes("@modelcontextprotocol/sdk")) return [];
      return allSpecifiers(file, text)
        .filter((s) => V1.test(s))
        .map((s) => `${path.relative(ROOT, file)} -> ${s}`);
    });
    expect(offenders).toEqual([]);
  });
});
