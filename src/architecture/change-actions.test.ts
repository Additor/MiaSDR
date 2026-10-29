import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseSource, walk } from "./source-ast";

/**
 * A browser change goes through `runApiAction` ("Change actions" in docs/decisions.md): it picks the sentence, reloads the
 * page when the page is behind and lets the screen word a 409. In a `"use client"` file under `src/app` or `src/components`,
 * every `callApi` whose method is not a literal "GET" is the first argument of `runApiAction`, alone or as a branch of a
 * conditional. A file listed below keeps its own handling, with the reason. Shrink only: an entry whose file no longer
 * breaks the rule fails the test.
 */

const ROOT = path.resolve(__dirname, "../..");

const OWN_HANDLING: Record<string, string> = {
  "src/app/(app)/actions/queue-group.tsx": "each queue row shows its own refusal and the next step for a stop review, so the group reads results per row",
  "src/app/(app)/inbox/[id]/_components/after-reply-controls.tsx": "after-reply commands follow the run's own state rules; that wiring changes with the after-reply queries",
  "src/app/(app)/inbox/[id]/_components/linkedin-reply-panel-client.tsx": "LinkedIn reply send: the send rules own its refusals and retries",
  "src/app/(app)/inbox/[id]/_components/reply-composer-client.tsx": "creates the reply draft that the reply send rules then hold",
  "src/app/(app)/inbox/[id]/_components/reply-panel-client.tsx": "email reply send: the send rules own its refusals, the in-flight lock and the draft edits",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return files(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

const isClientEntry = (text: string) => /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(text);

function isGet(call: ts.CallExpression): boolean {
  const method = call.arguments[1];
  return method !== undefined && ts.isStringLiteralLike(method) && method.text === "GET";
}

/** True when `call` is the first argument of `runApiAction`, directly or as a branch of a conditional. */
function insideRunApiAction(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (ts.isConditionalExpression(node.parent) && node !== node.parent.condition) node = node.parent;
  const parent = node.parent;
  return ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "runApiAction" && parent.arguments[0] === node;
}

/** "file:line" for each mutating `callApi` outside `runApiAction` in a client file. */
function looseChanges(): string[] {
  const found: string[] = [];
  for (const dir of ["src/app", "src/components"]) {
    for (const file of files(path.join(ROOT, dir))) {
      const text = readFileSync(file, "utf8");
      if (!isClientEntry(text)) continue;
      const sf = parseSource(file, text);
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      walk(sf, (node) => {
        if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "callApi") return;
        if (isGet(node) || insideRunApiAction(node)) return;
        found.push(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      });
    }
  }
  return found;
}

describe("change actions", () => {
  it("send every browser change through runApiAction", () => {
    const loose = looseChanges();
    const files = [...new Set(loose.map((at) => at.slice(0, at.lastIndexOf(":"))))].sort();
    expect(loose.filter((at) => !Object.hasOwn(OWN_HANDLING, at.slice(0, at.lastIndexOf(":"))))).toEqual([]);
    // Shrink only: a listed file that follows the rule now leaves the list.
    expect(Object.keys(OWN_HANDLING).filter((file) => !files.includes(file))).toEqual([]);
  });
});
