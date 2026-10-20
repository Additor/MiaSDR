/**
 * Parser for the grid's formula language, a small expression grammar over cell references.
 *
 *   {{firstName}} + " " + {{lastName}}
 *   IF(ISBLANK({{email}}), "none", LOWER({{email}}))
 *   LOOKUP("Companies", {{domain}}, "Domain", "Industry")
 *
 * Nothing here evaluates host code: there is no property access, no assignment,
 * no statements and no identifier that resolves to a global. A name is either a
 * function call, a literal (true, false, null) or a syntax error. Input size,
 * token count and nesting depth are capped before any recursion happens.
 */

import { normalizeKey, scanKey } from "./keys";

export const FORMULA_LIMITS = {
  /** Characters in one expression. */
  maxLength: 5_000,
  maxTokens: 1_200,
  /** Nesting of parentheses, calls, unary operators and ternaries. */
  maxDepth: 48,
  /** Height of the finished tree. A chain of 1,000 additions is wide but must not be deep. */
  maxTreeHeight: 160,
  maxNodes: 2_500,
  /** Evaluation steps for one row. Each node, and each element a function walks, costs one. */
  maxSteps: 60_000,
  maxStringLength: 100_000,
  maxArrayLength: 10_000,
  maxArgs: 32,
  /** Segments in a JSON_VALUE path, and the longest path text. */
  maxJsonPathSegments: 32,
  maxJsonPathLength: 500,
} as const;

/** Functions whose result depends on the clock. A formula that calls one is volatile. */
export const VOLATILE_FUNCTIONS: ReadonlySet<string> = new Set(["TODAY", "NOW"]);

/**
 * What kind of failure a formula hit. `REF` means a LOOKUP names a table or column that no longer exists
 * (or matches twice), `LOOKUP` means the source exists but could not be read, `ERROR` is any other failure.
 */
export type FormulaErrorCode = "ERROR" | "REF" | "LOOKUP";

/**
 * `data` errors come from the row's values (division by zero, a bad date) and ISERROR/IFERROR may catch them.
 * `limit` errors mean the formula hit a resource guard, and `time` means the caller gave no clock. Both propagate
 * past ISERROR/IFERROR so a guard or a configuration fault never reads as a data problem.
 */
export type FormulaErrorKind = "data" | "limit" | "time";

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly code: FormulaErrorCode = "ERROR",
    readonly kind: FormulaErrorKind = "data",
  ) {
    super(message);
    this.name = "FormulaError";
  }
}

export type Node =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "cell"; key: string }
  | { kind: "array"; items: Node[] }
  | { kind: "unary"; op: "!" | "-" | "+"; operand: Node }
  | { kind: "binary"; op: BinaryOp; left: Node; right: Node }
  | { kind: "ternary"; test: Node; then: Node; otherwise: Node }
  | { kind: "call"; name: string; args: Node[] };

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "^" | "&" | "==" | "!=" | "<" | ">" | "<=" | ">=" | "&&" | "||";

type Token =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "cell"; value: string }
  | { type: "name"; value: string }
  | { type: "op"; value: string }
  | { type: "end" };

const isDigit = (c: string) => c >= "0" && c <= "9";
const isNameStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isNameChar = (c: string) => isNameStart(c) || isDigit(c);

const OPERATORS = ["===", "!==", "<=", ">=", "==", "!=", "<>", "&&", "||", "+", "-", "*", "/", "%", "^", "&", "<", ">", "=", "!", "(", ")", "[", "]", ",", "?", ":"];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > FORMULA_LIMITS.maxTokens) throw new FormulaError("The formula is too long");
  };
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "{") {
      if (source[i + 1] !== "{") throw new FormulaError("Unexpected { in the formula. Reference a column as {{key}}");
      let j = i + 2;
      while (source[j] === " ") j += 1;
      const key = scanKey(source, j);
      j += key.length;
      while (source[j] === " ") j += 1;
      if (!key || source[j] !== "}" || source[j + 1] !== "}") throw new FormulaError("A column reference must look like {{key}}");
      push({ type: "cell", value: normalizeKey(key) });
      i = j + 2;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      let j = i;
      while (isDigit(source[j] ?? "")) j += 1;
      if (source[j] === ".") {
        j += 1;
        while (isDigit(source[j] ?? "")) j += 1;
      }
      if ((source[j] === "e" || source[j] === "E") && (isDigit(source[j + 1] ?? "") || ((source[j + 1] === "+" || source[j + 1] === "-") && isDigit(source[j + 2] ?? "")))) {
        j += 2;
        while (isDigit(source[j] ?? "")) j += 1;
      }
      const value = Number(source.slice(i, j));
      if (!Number.isFinite(value)) throw new FormulaError("That number is too large");
      if (isNameStart(source[j] ?? "")) throw new FormulaError(`Unexpected "${source[j]}" after a number`);
      push({ type: "num", value });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= source.length) throw new FormulaError("A text value is missing its closing quote");
        const d = source[j];
        if (d === c) break;
        if (d === "\\") {
          const e = source[j + 1];
          if (e === undefined) throw new FormulaError("A text value is missing its closing quote");
          value += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
          continue;
        }
        value += d;
        j += 1;
      }
      push({ type: "str", value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      push({ type: "name", value: source.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (op) {
      push({ type: "op", value: op });
      i += op.length;
      continue;
    }
    if (c === "." || c === "`" || c === "$" || c === ";" || c === "\\" || c === "#" || c === "@" || c === "~" || c === "|") {
      throw new FormulaError(c === "." ? "Property access is not supported in formulas" : `Unexpected "${c}" in the formula`);
    }
    throw new FormulaError(`Unexpected "${c}" in the formula`);
  }
  tokens.push({ type: "end" });
  return tokens;
}

const BINARY_LEVELS: Array<{ ops: string[] }> = [
  { ops: ["||"] },
  { ops: ["&&"] },
  { ops: ["==", "===", "!=", "!==", "<>", "="] },
  { ops: ["<", ">", "<=", ">="] },
  { ops: ["&"] },
  { ops: ["+", "-"] },
  { ops: ["*", "/", "%"] },
];

const OP_ALIASES: Record<string, BinaryOp> = { "===": "==", "!==": "!=", "<>": "!=", "=": "==" };

class Parser {
  private pos = 0;
  private depth = 0;
  nodes = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t.type === "op" && t.value === value;
  }

  private expectOp(value: string): void {
    if (!this.isOp(value)) throw new FormulaError(`Expected "${value}"${this.describeNext()}`);
    this.pos += 1;
  }

  private describeNext(): string {
    const t = this.peek();
    if (t.type === "end") return " but the formula ended";
    return ` but found "${t.type === "cell" ? `{{${t.value}}}` : String(t.value)}"`;
  }

  private make<T extends Node>(node: T): T {
    this.nodes += 1;
    if (this.nodes > FORMULA_LIMITS.maxNodes) throw new FormulaError("The formula is too complex");
    return node;
  }

  private enter(): void {
    this.depth += 1;
    if (this.depth > FORMULA_LIMITS.maxDepth) throw new FormulaError(`The formula is nested more than ${FORMULA_LIMITS.maxDepth} levels deep`);
  }

  private leave(): void {
    this.depth -= 1;
  }

  parse(): Node {
    const node = this.expression();
    if (this.peek().type !== "end") throw new FormulaError(`Unexpected input${this.describeNext()}`);
    return node;
  }

  private expression(): Node {
    this.enter();
    try {
      const test = this.binary(0);
      if (this.isOp("?")) {
        this.pos += 1;
        const then = this.expression();
        this.expectOp(":");
        const otherwise = this.expression();
        return this.make({ kind: "ternary", test, then, otherwise });
      }
      return test;
    } finally {
      this.leave();
    }
  }

  private binary(level: number): Node {
    if (level >= BINARY_LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.type !== "op" || !BINARY_LEVELS[level].ops.includes(t.value)) return left;
      this.pos += 1;
      const right = this.binary(level + 1);
      const op = (OP_ALIASES[t.value] ?? t.value) as BinaryOp;
      left = this.make({ kind: "binary", op, left, right });
    }
  }

  private unary(): Node {
    const t = this.peek();
    if (t.type === "op" && (t.value === "!" || t.value === "-" || t.value === "+")) {
      this.pos += 1;
      this.enter();
      try {
        return this.make({ kind: "unary", op: t.value, operand: this.unary() });
      } finally {
        this.leave();
      }
    }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (this.isOp("^")) {
      this.pos += 1;
      this.enter();
      try {
        // Right associative: 2 ^ 3 ^ 2 is 2 ^ 9.
        return this.make({ kind: "binary", op: "^", left: base, right: this.unary() });
      } finally {
        this.leave();
      }
    }
    return base;
  }

  private primary(): Node {
    const t = this.next();
    switch (t.type) {
      case "num":
        return this.make({ kind: "num", value: t.value });
      case "str":
        return this.make({ kind: "str", value: t.value });
      case "cell":
        return this.make({ kind: "cell", key: t.value });
      case "name": {
        if (this.isOp("(")) return this.call(t.value);
        const lower = t.value.toLowerCase();
        if (lower === "true") return this.make({ kind: "bool", value: true });
        if (lower === "false") return this.make({ kind: "bool", value: false });
        if (lower === "null") return this.make({ kind: "null" });
        throw new FormulaError(`"${t.value}" is not a function or value. Reference a column as {{key}}`);
      }
      case "op": {
        if (t.value === "(") {
          const inner = this.expression();
          this.expectOp(")");
          return inner;
        }
        if (t.value === "[") {
          const items: Node[] = [];
          if (!this.isOp("]")) {
            for (;;) {
              items.push(this.expression());
              if (items.length > FORMULA_LIMITS.maxArgs * 8) throw new FormulaError("A list in a formula can hold at most 256 items");
              if (this.isOp(",")) {
                this.pos += 1;
                continue;
              }
              break;
            }
          }
          this.expectOp("]");
          return this.make({ kind: "array", items });
        }
        throw new FormulaError(`Unexpected "${t.value}"`);
      }
      case "end":
        throw new FormulaError("The formula ended unexpectedly");
    }
  }

  private call(name: string): Node {
    this.expectOp("(");
    const args: Node[] = [];
    if (!this.isOp(")")) {
      for (;;) {
        args.push(this.expression());
        if (args.length > FORMULA_LIMITS.maxArgs) throw new FormulaError(`${name.toUpperCase()} takes at most ${FORMULA_LIMITS.maxArgs} arguments`);
        if (this.isOp(",")) {
          this.pos += 1;
          continue;
        }
        break;
      }
    }
    this.expectOp(")");
    return this.make({ kind: "call", name: name.toUpperCase(), args });
  }
}

function height(node: Node): number {
  // Iterative: a tree this deep is the thing being measured, so recursion is off the table.
  let max = 0;
  const stack: Array<[Node, number]> = [[node, 1]];
  while (stack.length > 0) {
    const [current, h] = stack.pop()!;
    if (h > max) max = h;
    if (max > FORMULA_LIMITS.maxTreeHeight) return max;
    switch (current.kind) {
      case "unary":
        stack.push([current.operand, h + 1]);
        break;
      case "binary":
        stack.push([current.left, h + 1], [current.right, h + 1]);
        break;
      case "ternary":
        stack.push([current.test, h + 1], [current.then, h + 1], [current.otherwise, h + 1]);
        break;
      case "call":
        for (const arg of current.args) stack.push([arg, h + 1]);
        break;
      case "array":
        for (const item of current.items) stack.push([item, h + 1]);
        break;
      default:
        break;
    }
  }
  return max;
}

/** Parses an expression. A single leading "=" is accepted, the way a spreadsheet writes a formula. */
export function parseFormula(expression: string): Node {
  if (typeof expression !== "string") throw new FormulaError("The formula must be text");
  if (expression.length > FORMULA_LIMITS.maxLength) throw new FormulaError(`The formula is longer than ${FORMULA_LIMITS.maxLength} characters`);
  const source = expression.trim().replace(/^=\s*/, "");
  if (!source) throw new FormulaError("The formula is empty");
  const parser = new Parser(tokenize(source));
  const ast = parser.parse();
  if (height(ast) > FORMULA_LIMITS.maxTreeHeight) throw new FormulaError("The formula is too deeply chained");
  return ast;
}

export interface LookupCall {
  table: string;
  lookupColumn: string;
  returnColumn: string;
}

export interface FormulaReferences {
  /** Column keys read through {{key}}. */
  cells: string[];
  lookups: LookupCall[];
  /** True when the formula calls TODAY or NOW. A volatile formula is recalculated when a row is edited and by Recalculate, never on a schedule. */
  volatile: boolean;
  /** True when the formula calls any date function, so the caller knows the organization time zone matters. */
  usesDates: boolean;
}

const DATE_FUNCTIONS: ReadonlySet<string> = new Set(["TODAY", "NOW", "DATE", "YEAR", "MONTH", "DAY", "DATEDIF"]);

/** TEXT reads the zone only when it formats with a pattern, which may be a date pattern. TEXT(x) alone does not. */
const isDateCall = (name: string, argCount: number): boolean => DATE_FUNCTIONS.has(name) || (name === "TEXT" && argCount >= 2);

/** Walks the tree without recursion and lists what the formula reads. */
export function referencesOf(ast: Node): FormulaReferences {
  const cells = new Set<string>();
  const lookups = new Map<string, LookupCall>();
  let volatile = false;
  let usesDates = false;
  const stack: Node[] = [ast];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.kind) {
      case "cell":
        cells.add(node.key);
        break;
      case "unary":
        stack.push(node.operand);
        break;
      case "binary":
        stack.push(node.left, node.right);
        break;
      case "ternary":
        stack.push(node.test, node.then, node.otherwise);
        break;
      case "array":
        stack.push(...node.items);
        break;
      case "call": {
        if (VOLATILE_FUNCTIONS.has(node.name)) volatile = true;
        if (isDateCall(node.name, node.args.length)) usesDates = true;
        if (node.name === "LOOKUP") {
          const [table, , lookupColumn, returnColumn] = node.args;
          if (node.args.length < 4 || node.args.length > 5 || table?.kind !== "str" || lookupColumn?.kind !== "str" || returnColumn?.kind !== "str") {
            throw new FormulaError('LOOKUP needs LOOKUP("Table", value, "Lookup column", "Return column") and an optional default. Table and column names must be quoted text.');
          }
          lookups.set(lookupSignature(table.value, lookupColumn.value, returnColumn.value), { table: table.value, lookupColumn: lookupColumn.value, returnColumn: returnColumn.value });
        }
        stack.push(...node.args);
        break;
      }
      default:
        break;
    }
  }
  return { cells: [...cells], lookups: [...lookups.values()], volatile, usesDates };
}

/** Stable key of one cross-table lookup, shared by the resolver that fills the registry and the evaluator that reads it. */
export function lookupSignature(table: string, lookupColumn: string, returnColumn: string): string {
  return JSON.stringify([table.trim().toLowerCase(), lookupColumn.trim().toLowerCase(), returnColumn.trim().toLowerCase()]);
}
