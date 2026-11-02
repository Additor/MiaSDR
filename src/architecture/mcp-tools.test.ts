import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";
import { parseSource, runtimeSpecifiers, walk } from "./source-ast";

/**
 * The MCP endpoint (src/app/api/mcp) acts for an agent, so every use case it calls must see `actor.via`. The only
 * source of that actor is `mcpActor` in `src/app/_lib/mcp.ts`:
 * - no file here imports `_lib/api.ts`, whose `toActor` builds a person's actor;
 * - no file here writes an object literal with `userId`, `organizationId` and `role`, which would be an actor without
 *   `via`.
 * Input limits come from the use case's own schema module, so a tool and its JSON route cannot drift: no Zod bound
 * (`min`, `max`, `length`, `gt`, `gte`, `lt`, `lte`, `multipleOf`) here takes a number written in place. `Math.min` and
 * `Math.max` are arithmetic and pass.
 */

const ROOT = path.resolve(__dirname, "../..");
const MCP_DIR = path.join(ROOT, "src/app/api/mcp");
const PERSON_WRAPPERS = new Set(["@/app/_lib/api"]);
const ACTOR_KEYS = ["userId", "organizationId", "role"];
const LIMIT_METHODS = new Set(["min", "max", "length", "gt", "gte", "lt", "lte", "multipleOf"]);

/** `100` or `-1`. */
const isNumberLiteral = (node: ts.Node) => ts.isNumericLiteral(node) || (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand));
const isMath = (node: ts.Expression) => ts.isIdentifier(node) && node.text === "Math";

const propertyName = (p: ts.ObjectLiteralElementLike) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null);

/** Each rule a source breaks, with the line. */
export function mcpToolProblems(file: string, text: string): string[] {
  const problems: string[] = [];
  for (const specifier of runtimeSpecifiers(file, text)) {
    if (PERSON_WRAPPERS.has(specifier) || /(^|\/)_lib\/api$/.test(specifier)) problems.push(`imports ${specifier}`);
  }
  const source = parseSource(file, text);
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  walk(source, (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set(node.properties.map(propertyName));
      if (ACTOR_KEYS.every((key) => names.has(key))) problems.push(`line ${line(node)}: an Actor literal; use mcpActor`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LIMIT_METHODS.has(node.expression.name.text) && !isMath(node.expression.expression)) {
      if (node.arguments.some(isNumberLiteral)) problems.push(`line ${line(node)}: .${node.expression.name.text}() with a number written in place`);
    }
  });
  return problems;
}

describe("MCP tools", () => {
  it("finds each kind of problem in a sample", () => {
    const sample = [
      `import { toActor } from "@/app/_lib/api";`,
      `const actor = { userId: "u", organizationId: "o", role: "member" };`,
      `const input = z.object({ name: z.string().max(100), tags: z.array(z.string()).min(1) });`,
      `import { mcpActor } from "@/app/_lib/mcp";`,
      `const fine = z.string().max(LIMITS.name);`,
      `const page = z.number().int().gte(-1).lt(50);`,
      `const capped = Math.min(1, Math.max(0, ratio));`,
    ].join("\n");
    expect(mcpToolProblems("sample.ts", sample)).toEqual([
      "imports @/app/_lib/api",
      "line 2: an Actor literal; use mcpActor",
      "line 3: .max() with a number written in place",
      "line 3: .min() with a number written in place",
      "line 6: .lt() with a number written in place",
      "line 6: .gte() with a number written in place",
    ]);
  });

  it("holds for every file under src/app/api/mcp", () => {
    const found: Record<string, string[]> = {};
    for (const file of sourceFiles(MCP_DIR)) {
      const problems = mcpToolProblems(file, readFileSync(file, "utf8"));
      if (problems.length > 0) found[path.relative(ROOT, file)] = problems;
    }
    expect(found).toEqual({});
  });
});
