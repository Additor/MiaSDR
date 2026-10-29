import ts from "typescript";
import { parseSource, walk } from "./source-ast";

/*
 * The scans behind claim-fences.test.ts. Each takes parsed sources and names findings as `file#method`: the nearest
 * named function, method or property around the statement. The test runs them on src and on fixtures.
 */

/** Statuses that mean a worker holds a lease on the row. */
export const LEASE_STATUSES = ["running", "drafting", "processing"];

/** Queue tables whose claims carry a token: every update or delete of them filters with `heldBy` or has a reason. */
export const FENCED_TABLES = [
  { drizzle: "aiJobs", raw: "ai_jobs" },
  { drizzle: "inboundEvents", raw: "inbound_events" },
];

export interface Source {
  file: string;
  ast: ts.SourceFile;
}

export const sourceOf = (file: string, text?: string): Source => ({ file, ast: parseSource(file, text) });

function nameOf(node: ts.Node): string | null {
  if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isPropertyAssignment(node)) && node.name) {
    if (ts.isPropertyAssignment(node) && !ts.isFunctionLike(node.initializer)) return null;
    return node.name.getText();
  }
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isFunctionLike(node.initializer)) return node.name.getText();
  return null;
}

/** `file#name` of the named function around `node`, or `file#<top>` outside one. */
function ownerOf(source: Source, node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    const name = nameOf(n);
    if (name) return `${source.file}#${name}`;
  }
  return `${source.file}#<top>`;
}

/** String constants declared at the top of the file (`const RUNNING = "running"`). */
function stringConsts(source: Source): Map<string, string> {
  const out = new Map<string, string>();
  for (const statement of source.ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteralLike(d.initializer)) out.set(d.name.text, d.initializer.text);
    }
  }
  return out;
}

/** Top-level object constants by name, so a spread (`...UNLOCK`) can be read for its keys. */
function objectConsts(source: Source): Map<string, ts.ObjectLiteralExpression> {
  const out = new Map<string, ts.ObjectLiteralExpression>();
  for (const statement of source.ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations) {
      let init = d.initializer;
      while (init && (ts.isAsExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
      if (ts.isIdentifier(d.name) && init && ts.isObjectLiteralExpression(init)) out.set(d.name.text, init);
    }
  }
  return out;
}

function hasKey(object: ts.ObjectLiteralExpression, key: string, objects: Map<string, ts.ObjectLiteralExpression>): boolean {
  return object.properties.some((p) => {
    if (ts.isSpreadAssignment(p)) {
      const spread = ts.isIdentifier(p.expression) ? objects.get(p.expression.text) : undefined;
      return spread ? hasKey(spread, key, objects) : false;
    }
    return p.name?.getText() === key;
  });
}

/** The SET clauses of a raw SQL text: from `set` to the next `where`, `from` or `returning`. */
const setClauses = (text: string) => [...text.toLowerCase().matchAll(/\bset\b([\s\S]*?)(?=\bwhere\b|\bfrom\b|\breturning\b|$)/g)].map((m) => m[1]);
const LEASE_IN_SQL = new RegExp(`\\bstatus\\s*=\\s*'(${LEASE_STATUSES.join("|")})'`);

const isSqlTemplate = (node: ts.Node): node is ts.TaggedTemplateExpression => ts.isTaggedTemplateExpression(node) && node.tag.getText() === "sql";

/** Rule (a): statements that write a lease status without writing `claim_token`. One entry per method. */
export function leaseWritesWithoutToken(sources: Source[]): string[] {
  const found = new Set<string>();
  for (const source of sources) {
    const strings = stringConsts(source);
    const objects = objectConsts(source);
    walk(source.ast, (node) => {
      if (isSqlTemplate(node) && !(node.parent && ts.isTemplateSpan(node.parent))) {
        if (setClauses(node.template.getText()).some((clause) => LEASE_IN_SQL.test(clause) && !/\bclaim_token\b/.test(clause))) found.add(ownerOf(source, node));
        return;
      }
      if (!ts.isObjectLiteralExpression(node)) return;
      const parent = node.parent;
      const written =
        (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && ["set", "values"].includes(parent.expression.name.text)) ||
        (ts.isPropertyAssignment(parent) && parent.name.getText() === "set");
      if (!written) return;
      const status = node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === "status");
      if (!status) return;
      const value = ts.isStringLiteralLike(status.initializer) ? status.initializer.text : ts.isIdentifier(status.initializer) ? strings.get(status.initializer.text) : undefined;
      if (value && LEASE_STATUSES.includes(value) && !hasKey(node, "claimToken", objects)) found.add(ownerOf(source, node));
    });
  }
  return [...found].sort();
}

/** Names of the top-level functions and constants of a file that call `heldBy`, directly or through each other. */
function fenceHelpers(source: Source): Set<string> {
  const bodies = new Map<string, ts.Node>();
  for (const statement of source.ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) bodies.set(statement.name.text, statement.body);
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) bodies.set(d.name.text, d.initializer);
    }
  }
  const helpers = new Set(["heldBy"]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, body] of bodies) {
      if (!helpers.has(name) && callsAny(body, helpers)) {
        helpers.add(name);
        grew = true;
      }
    }
  }
  return helpers;
}

function callsAny(node: ts.Node, names: Set<string>): boolean {
  let hit = false;
  walk(node, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) hit = true;
  });
  return hit;
}

/** Types that carry a claim: a `claimToken` member, or a member typed with such a type (`job: ClaimedJob`). */
export function claimTypes(sources: Source[]): Set<string> {
  const declared: Array<{ name: string; members: ts.NodeArray<ts.TypeElement> }> = [];
  for (const source of sources) {
    walk(source.ast, (node) => {
      if (ts.isInterfaceDeclaration(node)) declared.push({ name: node.name.text, members: node.members });
      if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) declared.push({ name: node.name.text, members: node.type.members });
    });
  }
  const claims = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, members } of declared) {
      if (claims.has(name)) continue;
      const carries = members.some((m) => ts.isPropertySignature(m) && (m.name.getText() === "claimToken" || (m.type !== undefined && mentions(m.type.getText(), claims))));
      if (carries) {
        claims.add(name);
        grew = true;
      }
    }
  }
  return claims;
}

const mentions = (typeText: string, names: Set<string>) => [...names].some((n) => new RegExp(`\\b${n}\\b`).test(typeText));

/** Store ports and the methods of each that take a claim. */
function claimPorts(sources: Source[], claims: Set<string>): Map<string, Set<string>> {
  const ports = new Map<string, Set<string>>();
  for (const source of sources) {
    walk(source.ast, (node) => {
      if (!ts.isInterfaceDeclaration(node) || claims.has(node.name.text)) return;
      const methods = node.members.filter(
        (m): m is ts.MethodSignature => ts.isMethodSignature(m) && m.parameters.some((p) => p.type !== undefined && mentions(p.type.getText(), claims)),
      );
      if (methods.length > 0) ports.set(node.name.text, new Set(methods.map((m) => m.name.getText())));
    });
  }
  return ports;
}

/** The interface an object literal implements: a typed constant, `satisfies`, or the return type of its function. */
function portOf(object: ts.ObjectLiteralExpression): string | null {
  const parent = object.parent;
  const typeName = (type: ts.TypeNode | undefined) => {
    if (!type) return null;
    const text = type.getText();
    return /^(Promise<)?([A-Za-z0-9_]+)/.exec(text.replace(/^Pick<|^Omit<|^Partial</, ""))?.[2] ?? null;
  };
  if (ts.isVariableDeclaration(parent)) return typeName(parent.type);
  if (ts.isSatisfiesExpression(parent) || ts.isAsExpression(parent)) return typeName(parent.type);
  if (ts.isReturnStatement(parent)) {
    for (let n: ts.Node | undefined = parent.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return typeName(n.type);
  }
  if (ts.isArrowFunction(parent)) return typeName(parent.type);
  return null;
}

/** Rule (b): methods of a store that take a claim and never reach `heldBy`. Also returns the ports it checked. */
export function claimMethodsWithoutFence(sources: Source[]): { unfenced: string[]; checked: string[] } {
  const ports = claimPorts(sources, claimTypes(sources));
  const unfenced: string[] = [];
  const checked = new Set<string>();
  for (const source of sources) {
    const helpers = fenceHelpers(source);
    walk(source.ast, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const port = portOf(node);
      const methods = port ? ports.get(port) : undefined;
      if (!methods) return;
      for (const p of node.properties) {
        const name = p.name?.getText();
        if (!name || !methods.has(name)) continue;
        checked.add(`${port}.${name}`);
        if (!callsAny(p, helpers)) unfenced.push(`${source.file}#${name}`);
      }
    });
  }
  return { unfenced: unfenced.sort(), checked: [...checked].sort() };
}

/** Rule (c): methods that update or delete a fenced table and never reach `heldBy`. */
export function fencedTableWritesWithoutFence(sources: Source[]): string[] {
  const found = new Set<string>();
  const drizzle = new RegExp(`^(${FENCED_TABLES.map((t) => t.drizzle).join("|")})$`);
  const raw = new RegExp(`\\b(update|delete from)\\s+(${FENCED_TABLES.map((t) => t.raw).join("|")})\\b`, "i");
  for (const source of sources) {
    const helpers = fenceHelpers(source);
    walk(source.ast, (node) => {
      const writes =
        (ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["update", "delete"].includes(node.expression.name.text) &&
          node.arguments.length === 1 &&
          drizzle.test(node.arguments[0].getText())) ||
        (isSqlTemplate(node) && raw.test(node.template.getText()));
      if (!writes) return;
      // The method that holds the statement, or the top-level helper it sits in.
      let owner: ts.Node | undefined = node.parent;
      while (owner && !nameOf(owner)) owner = owner.parent;
      if (!owner || !callsAny(owner, helpers)) found.add(ownerOf(source, node));
    });
  }
  return [...found].sort();
}
