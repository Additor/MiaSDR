import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { API_ROOT, HTTP_METHODS, type HttpMethod } from "@/test-support/route-client";
import { ROUTES } from "./route-matrix/route-matrix-spec";
import { parseSource, walk } from "./source-ast";

/**
 * Every protected route handler (`ROUTES` in the route matrix spec) reads the session through `withActor`, `withUser` or
 * `withAdmin` (src/app/_lib/api.ts), so it answers 401 and the application errors in the one shape the client reads.
 * A handler that calls a session reader itself skips that mapping.
 */

/** The session readers a handler must leave to the wrappers. `getSession` also matches `auth().api.getSession`. */
const SESSION_READERS = new Set(["apiOrgContext", "apiUser", "getSession", "requireOrgContext", "resolveOrgContext"]);

/** Handlers that still read the session themselves, as `METHOD route-key`, each with its reason. Shrink only. */
const READS_SESSION_ITSELF: Record<string, string> = {
  "GET invitations/[id]": "The accept-invitation page's data, for a signed-in user who usually has no organization yet. The view depends on the session's email, which `withUser` does not hand over (`SessionUser` carries no email), so it reads the Better Auth session itself.",
  "GET leads/export": "Not moved yet.",
  "POST leads/import": "Not moved yet.",
  "POST leads/import/preview": "Not moved yet.",
  "POST leads/import/summary": "Not moved yet.",
  "GET leads/import/sample": "Not moved yet.",
  "GET linkedin/search-batches/[id]/results": "Not moved yet.",
  "GET linkedin/search-batches/template": "Not moved yet.",
};

/** The exported handler a top-level statement declares (`export function GET`, `export const GET = ...`), if any. */
function declaredHandler(statement: ts.Statement): HttpMethod | null {
  const exported = (ts.getModifiers(statement as ts.HasModifiers) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (!exported) return null;
  const names = ts.isFunctionDeclaration(statement)
    ? [statement.name?.text]
    : ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : undefined))
      : [];
  return HTTP_METHODS.find((m) => names.includes(m)) ?? null;
}

/**
 * The handlers of a route source that call a session reader. A call inside a handler counts for that handler; a call
 * in a module-level helper counts for every handler the module exports, since any of them may reach it.
 */
export function handlersReadingSession(file: string, text?: string): HttpMethod[] {
  const source = parseSource(file, text);
  const handlers = source.statements.map(declaredHandler).filter((m): m is HttpMethod => m !== null);
  const found = new Set<HttpMethod>();
  for (const statement of source.statements) {
    let calls = false;
    walk(statement, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name && SESSION_READERS.has(name)) calls = true;
    });
    if (!calls) continue;
    const handler = declaredHandler(statement);
    for (const method of handler ? [handler] : handlers) found.add(method);
  }
  return HTTP_METHODS.filter((m) => found.has(m));
}

describe("route wrappers", () => {
  it("leaves the session to withActor, withUser or withAdmin in every protected handler but the listed ones", () => {
    const found: Record<string, string> = {};
    for (const key of Object.keys(ROUTES).sort()) {
      for (const method of handlersReadingSession(path.join(API_ROOT, key, "route.ts"))) {
        const entry = `${method} ${key}`;
        found[entry] = READS_SESSION_ITSELF[entry] ?? "(not listed: wrap the handler in withActor, withUser or withAdmin)";
      }
    }
    expect(found).toEqual(READS_SESSION_ITSELF);
  });

  it("finds a session read in a handler, through a property access, and in a helper every handler shares", () => {
    const read = (text: string) => handlersReadingSession("route.ts", text);
    expect(read("export async function GET() { const ctx = await apiOrgContext(); }\nexport const POST = () => withActor(async () => 1);")).toEqual(["GET"]);
    expect(read("export const GET = async () => { await auth().api.getSession({ headers: await headers() }); };")).toEqual(["GET"]);
    expect(read("async function who() { return apiUser(); }\nexport function GET() { return who(); }\nexport function DELETE() { return who(); }")).toEqual(["GET", "DELETE"]);
    expect(read("import { withActor } from '@/app/_lib/api';\nexport function GET() { return withActor(async () => ({ ok: true })); }")).toEqual([]);
  });
});
