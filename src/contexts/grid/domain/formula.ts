import { parseNumericText } from "./cell-values";
import { dateDiff, formatDate, formatIsoDate, formatNumber, isRealDate, nowIn, parseDateFormat, parseIsoDate, todayIn, type CivilDate } from "./formula-dates";
import { FORMULA_LIMITS, FormulaError, lookupSignature, parseFormula, referencesOf, type FormulaErrorCode, type FormulaReferences, type Node } from "./formula-parser";

export { FORMULA_LIMITS, FormulaError, lookupSignature, parseFormula, referencesOf };
export type { FormulaErrorCode, FormulaReferences, LookupCall } from "./formula-parser";

/**
 * Evaluator for the grid's formula language. Pure: it reads the row it is given
 * and a lookup registry the caller built, and touches nothing else. The only
 * names that resolve are the built-in functions in `FUNCTIONS`, found through a
 * Map, so `constructor`, `__proto__` and friends are unknown functions.
 */

export type FormulaValue = null | boolean | number | string | FormulaValue[];

/** A LOOKUP source that could not be resolved or read. Evaluating the call fails with `code` and `reason`. */
export class LookupFailure {
  constructor(
    readonly code: Exclude<FormulaErrorCode, "ERROR">,
    readonly reason: string,
  ) {}
}

/**
 * Cross-table lookups, keyed by lookupSignature(). The inner map goes from a lookup value key to the returned value.
 * A signature that failed to resolve holds a `LookupFailure`. When a registry is given at all, a LOOKUP whose
 * signature is missing from it is an error too, so a source that vanished never reads as an empty table.
 */
export type FormulaLookupRegistry = Record<string, Map<string, unknown> | Record<string, unknown> | LookupFailure>;

/** Text shown in a cell whose formula failed. The reason goes to the cell's metadata. */
export const FORMULA_ERROR_TEXT: Record<FormulaErrorCode, string> = { ERROR: "#ERROR", REF: "#REF", LOOKUP: "#LOOKUP" };

export interface EvaluateOptions {
  /** Keys of text-like columns. A blank cell in one reads as "" instead of null, so joins do not print "null". */
  textKeys?: ReadonlySet<string>;
  lookups?: FormulaLookupRegistry;
  /**
   * The clock for TODAY and NOW. The engine never reads the system clock, so a caller that wants these
   * functions to work passes the instant. Without it they fail with an error.
   */
  now?: Date;
  /** IANA zone (the organization's) that decides what day it is and which day an offset timestamp falls on. Defaults to UTC. */
  timeZone?: string;
}

export type FormulaResult = { ok: true; value: FormulaValue } | { ok: false; error: string; code: FormulaErrorCode };

export interface CompiledFormula {
  ast: Node;
  references: FormulaReferences;
}

export function compileFormula(expression: string): { ok: true; formula: CompiledFormula } | { ok: false; error: string } {
  try {
    const ast = parseFormula(expression);
    return { ok: true, formula: { ast, references: referencesOf(ast) } };
  } catch (error) {
    return { ok: false, error: error instanceof FormulaError ? error.message : "The formula could not be read" };
  }
}

/** Compiles then evaluates. Returns a result, never throws. */
export function evaluateFormula(expression: string | CompiledFormula, row: Record<string, unknown>, options: EvaluateOptions = {}): FormulaResult {
  let compiled: CompiledFormula;
  if (typeof expression === "string") {
    const result = compileFormula(expression);
    if (!result.ok) return { ok: false, error: result.error, code: "ERROR" };
    compiled = result.formula;
  } else {
    compiled = expression;
  }
  const run = new Run(row, options);
  try {
    const value = run.evaluate(compiled.ast);
    if (Array.isArray(value) && value.length > FORMULA_LIMITS.maxArrayLength) throw new FormulaError("The result list is too large", "ERROR", "limit");
    return { ok: true, value };
  } catch (error) {
    if (error instanceof FormulaError) return { ok: false, error: error.message, code: error.code };
    // A stack overflow or similar means the input beat our limits. Report it without echoing internals.
    return { ok: false, error: "The formula could not be evaluated", code: "ERROR" };
  }
}

/** True when the value counts as empty for MISS/HIT style outcomes. */
export const isEmptyResult = (value: FormulaValue): boolean => value === null || value === "" || (Array.isArray(value) && value.length === 0);

class Run {
  private steps = 0;

  constructor(
    private readonly row: Record<string, unknown>,
    readonly options: EvaluateOptions,
  ) {}

  get zone(): string {
    return this.options.timeZone || "UTC";
  }

  charge(amount = 1): void {
    this.steps += amount;
    if (this.steps > FORMULA_LIMITS.maxSteps) throw new FormulaError("The formula needs too much work to evaluate", "ERROR", "limit");
  }

  readCell(key: string): FormulaValue {
    if (!Object.prototype.hasOwnProperty.call(this.row, key)) return this.options.textKeys?.has(key) ? "" : null;
    const raw = this.row[key];
    if (raw === undefined || raw === null || raw === "") return this.options.textKeys?.has(key) ? "" : null;
    return toValue(raw);
  }

  evaluate(node: Node): FormulaValue {
    this.charge();
    switch (node.kind) {
      case "num":
      case "str":
      case "bool":
        return node.value;
      case "null":
        return null;
      case "cell":
        return this.readCell(node.key);
      case "array": {
        const items = node.items.map((item) => this.evaluate(item));
        return items;
      }
      case "unary": {
        const v = this.evaluate(node.operand);
        if (node.op === "!") return !truthy(v);
        const n = toNumber(v);
        return node.op === "-" ? -n : n;
      }
      case "ternary":
        return truthy(this.evaluate(node.test)) ? this.evaluate(node.then) : this.evaluate(node.otherwise);
      case "binary":
        return this.binary(node);
      case "call":
        return this.call(node);
    }
  }

  private binary(node: Extract<Node, { kind: "binary" }>): FormulaValue {
    if (node.op === "&&") {
      const left = this.evaluate(node.left);
      return truthy(left) ? truthy(this.evaluate(node.right)) : false;
    }
    if (node.op === "||") {
      const left = this.evaluate(node.left);
      return truthy(left) ? true : truthy(this.evaluate(node.right));
    }
    const left = this.evaluate(node.left);
    const right = this.evaluate(node.right);
    switch (node.op) {
      case "+":
        if (typeof left === "string" || typeof right === "string") return joinText(toText(left), toText(right));
        return finite(toNumber(left) + toNumber(right));
      case "&":
        return joinText(toText(left), toText(right));
      case "-":
        return finite(toNumber(left) - toNumber(right));
      case "*":
        return finite(toNumber(left) * toNumber(right));
      case "/": {
        const divisor = toNumber(right);
        if (divisor === 0) throw new FormulaError("Division by zero");
        return finite(toNumber(left) / divisor);
      }
      case "%": {
        const divisor = toNumber(right);
        if (divisor === 0) throw new FormulaError("Division by zero");
        return finite(toNumber(left) % divisor);
      }
      case "^":
        return finite(Math.pow(toNumber(left), toNumber(right)));
      case "==":
        return looseEquals(left, right);
      case "!=":
        return !looseEquals(left, right);
      case "<":
        return compare(left, right) < 0;
      case ">":
        return compare(left, right) > 0;
      case "<=":
        return compare(left, right) <= 0;
      case ">=":
        return compare(left, right) >= 0;
    }
  }

  private call(node: Extract<Node, { kind: "call" }>): FormulaValue {
    const fn = FUNCTIONS.get(node.name);
    if (!fn) throw new FormulaError(`Unknown function ${node.name}`);
    if (node.args.length < fn.min || node.args.length > fn.max) {
      throw new FormulaError(`${node.name} takes ${fn.min === fn.max ? fn.min : `${fn.min} to ${fn.max === Infinity ? "many" : fn.max}`} argument${fn.max === 1 ? "" : "s"}`);
    }
    if (fn.lazy) return fn.lazy(node.args, this);
    return fn.run(node.args.map((arg) => this.evaluate(arg)), this);
  }
}

/* ------------------------------------------------------------------ values */

/** A stored cell becomes a formula value. Objects turn into JSON text, and arrays keep scalars only. */
function toValue(raw: unknown): FormulaValue {
  if (typeof raw === "string") return raw.length > FORMULA_LIMITS.maxStringLength ? raw.slice(0, FORMULA_LIMITS.maxStringLength) : raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) return raw.slice(0, FORMULA_LIMITS.maxArrayLength).map((item) => (item !== null && typeof item === "object" ? JSON.stringify(item).slice(0, 1000) : toValue(item)));
  if (raw !== null && typeof raw === "object") return (JSON.stringify(raw) ?? "").slice(0, FORMULA_LIMITS.maxStringLength);
  return null;
}

function truthy(value: FormulaValue): boolean {
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value.toLowerCase() !== "false";
  return value.length > 0;
}

function toText(value: FormulaValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
  if (typeof value === "boolean") return value ? "true" : "false";
  return value.map(toText).join(", ");
}

function toNumber(value: FormulaValue): number {
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    if (value.trim() === "") return 0;
    const n = parseNumericText(value);
    if (n === null) throw new FormulaError(`"${value.length > 30 ? `${value.slice(0, 30)}...` : value}" is not a number`);
    return n;
  }
  throw new FormulaError("A list cannot be used as a number here");
}

function finite(n: number): number {
  if (!Number.isFinite(n)) throw new FormulaError("The result is not a finite number");
  return n;
}

function guardText(text: string): string {
  if (text.length > FORMULA_LIMITS.maxStringLength) throw new FormulaError(`Text longer than ${FORMULA_LIMITS.maxStringLength.toLocaleString("en-US")} characters is not allowed`, "ERROR", "limit");
  return text;
}

function joinText(a: string, b: string): string {
  if (a.length + b.length > FORMULA_LIMITS.maxStringLength) throw new FormulaError(`Text longer than ${FORMULA_LIMITS.maxStringLength.toLocaleString("en-US")} characters is not allowed`, "ERROR", "limit");
  return a + b;
}

function looseEquals(a: FormulaValue, b: FormulaValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return toText(a) === toText(b);
  const blankA = a === null || a === "";
  const blankB = b === null || b === "";
  if (blankA || blankB) return blankA && blankB;
  if (typeof a === typeof b) return a === b;
  if (typeof a === "number" && typeof b === "string") return parseNumericText(b) === a;
  if (typeof a === "string" && typeof b === "number") return parseNumericText(a) === b;
  return toText(a) === toText(b);
}

function compare(a: FormulaValue, b: FormulaValue): number {
  if (typeof a === "string" && typeof b === "string") {
    const na = parseNumericText(a);
    const nb = parseNumericText(b);
    if (na !== null && nb !== null) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return toNumber(a) - toNumber(b);
}

/* --------------------------------------------------------------- functions */

interface FormulaFunction {
  min: number;
  max: number;
  run: (args: FormulaValue[], ctx: Run) => FormulaValue;
  lazy?: (args: Node[], ctx: Run) => FormulaValue;
}

const FUNCTIONS = new Map<string, FormulaFunction>();

function def(names: string | string[], min: number, max: number, run: FormulaFunction["run"]): void {
  for (const name of Array.isArray(names) ? names : [names]) FUNCTIONS.set(name, { min, max, run });
}

function defLazy(name: string, min: number, max: number, lazy: NonNullable<FormulaFunction["lazy"]>): void {
  FUNCTIONS.set(name, { min, max, run: () => null, lazy });
}

/** Flattens arguments into scalars, charging one step per element so a long list cannot hide cost. */
function flatten(args: FormulaValue[], ctx: Run): FormulaValue[] {
  const out: FormulaValue[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) {
      ctx.charge(arg.length);
      for (const item of arg) out.push(Array.isArray(item) ? toText(item) : item);
    } else {
      out.push(arg);
    }
  }
  return out;
}

function numbersOf(args: FormulaValue[], ctx: Run): number[] {
  return flatten(args, ctx)
    .filter((v) => v !== null && v !== "")
    .map(toNumber);
}

const intArg = (value: FormulaValue, label: string, max = 1_000_000): number => {
  const n = Math.trunc(toNumber(value));
  if (n < 0 || n > max) throw new FormulaError(`${label} must be between 0 and ${max.toLocaleString("en-US")}`);
  return n;
};

defLazy("IF", 2, 3, (args, ctx) => (truthy(ctx.evaluate(args[0])) ? ctx.evaluate(args[1]) : args[2] ? ctx.evaluate(args[2]) : null));
defLazy("AND", 1, FORMULA_LIMITS.maxArgs, (args, ctx) => args.every((a) => truthy(ctx.evaluate(a))));
defLazy("OR", 1, FORMULA_LIMITS.maxArgs, (args, ctx) => args.some((a) => truthy(ctx.evaluate(a))));
defLazy("IFERROR", 2, 2, (args, ctx) => {
  try {
    return ctx.evaluate(args[0]);
  } catch (error) {
    if (error instanceof FormulaError && error.kind === "data") return ctx.evaluate(args[1]);
    throw error;
  }
});
defLazy("COALESCE", 1, FORMULA_LIMITS.maxArgs, (args, ctx) => {
  for (const arg of args) {
    const v = ctx.evaluate(arg);
    if (v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) return v;
  }
  return null;
});
def("NOT", 1, 1, ([v]) => !truthy(v));
def("ISBLANK", 1, 1, ([v]) => v === null || v === "" || (Array.isArray(v) && v.length === 0));
def("ISNUMBER", 1, 1, ([v]) => typeof v === "number" || (typeof v === "string" && parseNumericText(v) !== null));
def("ISTEXT", 1, 1, ([v]) => typeof v === "string");

def(["CONCATENATE", "CONCAT"], 1, FORMULA_LIMITS.maxArgs, (args, ctx) => guardText(flatten(args, ctx).map(toText).join("")));
def("TEXTJOIN", 2, FORMULA_LIMITS.maxArgs, ([delimiter, ...rest], ctx) => {
  const parts = flatten(rest, ctx).filter((v) => v !== null && v !== "").map(toText);
  return guardText(parts.join(toText(delimiter)));
});
def("JOIN", 2, 2, ([list, delimiter], ctx) => {
  const parts = flatten([list], ctx).filter((v) => v !== null && v !== "").map(toText);
  return guardText(parts.join(toText(delimiter)));
});
def("UPPER", 1, 1, ([v]) => toText(v).toUpperCase());
def("LOWER", 1, 1, ([v]) => toText(v).toLowerCase());
def("PROPER", 1, 1, ([v]) => toText(v).toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase()));
def("TRIM", 1, 1, ([v]) => toText(v).trim().replace(/\s+/g, " "));
def("LEN", 1, 1, ([v]) => (Array.isArray(v) ? v.length : toText(v).length));
def("LEFT", 1, 2, ([v, n]) => toText(v).slice(0, n === undefined ? 1 : intArg(n, "LEFT length")));
def("RIGHT", 1, 2, ([v, n]) => {
  const text = toText(v);
  const count = n === undefined ? 1 : intArg(n, "RIGHT length");
  return count === 0 ? "" : text.slice(-count);
});
def("MID", 3, 3, ([v, start, length]) => {
  const from = Math.max(1, Math.trunc(toNumber(start)));
  return toText(v).slice(from - 1, from - 1 + intArg(length, "MID length"));
});
def("SUBSTITUTE", 3, 3, ([v, from, to]) => {
  const find = toText(from);
  const text = toText(v);
  if (find === "") return text;
  return guardText(text.split(find).join(toText(to)));
});
def("FIND", 2, 3, ([needle, haystack, start]) => {
  const index = toText(haystack).indexOf(toText(needle), start === undefined ? 0 : Math.max(0, Math.trunc(toNumber(start)) - 1));
  return index === -1 ? null : index + 1;
});
def("CONTAINS", 2, 2, ([v, needle]) => toText(v).toLowerCase().includes(toText(needle).toLowerCase()));
def("STARTSWITH", 2, 2, ([v, prefix]) => toText(v).toLowerCase().startsWith(toText(prefix).toLowerCase()));
def("ENDSWITH", 2, 2, ([v, suffix]) => toText(v).toLowerCase().endsWith(toText(suffix).toLowerCase()));
def("SPLIT", 2, 3, ([v, delimiter, index], ctx) => {
  const delim = toText(delimiter);
  if (delim === "") throw new FormulaError("SPLIT needs a separator");
  const text = toText(v);
  if (index === undefined) {
    const parts = text.split(delim, FORMULA_LIMITS.maxArrayLength);
    ctx.charge(parts.length);
    return parts;
  }
  const part = text.split(delim)[Math.trunc(toNumber(index)) - 1];
  return part === undefined ? null : part;
});
def("REPEAT", 2, 2, ([v, n]) => {
  const text = toText(v);
  const count = intArg(n, "REPEAT count", FORMULA_LIMITS.maxStringLength);
  if (text.length * count > FORMULA_LIMITS.maxStringLength) throw new FormulaError(`Text longer than ${FORMULA_LIMITS.maxStringLength.toLocaleString("en-US")} characters is not allowed`, "ERROR", "limit");
  return text.repeat(count);
});
def("DOMAIN", 1, 1, ([v]) => {
  let text = toText(v).trim().toLowerCase();
  if (text === "") return null;
  if (text.includes("@")) text = text.slice(text.lastIndexOf("@") + 1);
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
  return text.split(/[/?#:]/)[0] || null;
});
/** Longest TEXT format. Real formats are under 20 characters. */
const MAX_TEXT_PATTERN = 64;
def("TEXT", 1, 2, ([v, format], ctx) => {
  if (format === undefined) return guardText(toText(v));
  const pattern = toText(format).trim();
  if (v === null || v === "") return "";
  ctx.charge(Math.ceil(pattern.length / 100));
  if (pattern.length > MAX_TEXT_PATTERN) throw new FormulaError(`TEXT formats can be at most ${MAX_TEXT_PATTERN} characters`);
  const dateFormat = parseDateFormat(pattern);
  if (dateFormat) {
    const date = parseIsoDate(toText(v), ctx.zone);
    if (!date) throw new FormulaError(`TEXT could not read ${quoted(v)} as an ISO date (2026-03-05)`);
    return formatDate(date, dateFormat);
  }
  const n = toNumber(v);
  const out = Math.abs(n) < 1e15 ? formatNumber(n, pattern) : null;
  if (out === null) throw new FormulaError(`TEXT does not support the format "${pattern.slice(0, 30)}". Use yyyy-mm-dd, dd/mm/yyyy, mmm d, yyyy, 0.00 or #,##0`);
  return out;
});
def(["NUMBER", "VALUE"], 1, 1, ([v]) => {
  if (v === null || v === "") return null;
  return toNumber(v);
});

def("ABS", 1, 1, ([v]) => Math.abs(toNumber(v)));
def("ROUND", 1, 2, ([v, digits]) => {
  const d = digits === undefined ? 0 : Math.max(-15, Math.min(15, Math.trunc(toNumber(digits))));
  const factor = 10 ** d;
  return finite(Math.round((toNumber(v) + Number.EPSILON * Math.sign(toNumber(v))) * factor) / factor);
});
def("FLOOR", 1, 1, ([v]) => Math.floor(toNumber(v)));
def(["CEILING", "CEIL"], 1, 1, ([v]) => Math.ceil(toNumber(v)));
def("INT", 1, 1, ([v]) => Math.trunc(toNumber(v)));
def("MOD", 2, 2, ([a, b]) => {
  const divisor = toNumber(b);
  if (divisor === 0) throw new FormulaError("Division by zero");
  return finite(toNumber(a) % divisor);
});
def("POWER", 2, 2, ([a, b]) => finite(Math.pow(toNumber(a), toNumber(b))));
def("SQRT", 1, 1, ([v]) => {
  const n = toNumber(v);
  if (n < 0) throw new FormulaError("SQRT needs a number that is zero or more");
  return Math.sqrt(n);
});
def("SUM", 1, FORMULA_LIMITS.maxArgs, (args, ctx) => finite(numbersOf(args, ctx).reduce((a, b) => a + b, 0)));
def(["AVERAGE", "AVG"], 1, FORMULA_LIMITS.maxArgs, (args, ctx) => {
  const nums = numbersOf(args, ctx);
  return nums.length === 0 ? null : finite(nums.reduce((a, b) => a + b, 0) / nums.length);
});
def("MIN", 1, FORMULA_LIMITS.maxArgs, (args, ctx) => {
  const nums = numbersOf(args, ctx);
  return nums.length === 0 ? null : nums.reduce((a, b) => Math.min(a, b));
});
def("MAX", 1, FORMULA_LIMITS.maxArgs, (args, ctx) => {
  const nums = numbersOf(args, ctx);
  return nums.length === 0 ? null : nums.reduce((a, b) => Math.max(a, b));
});
def("COUNT", 1, FORMULA_LIMITS.maxArgs, (args, ctx) => flatten(args, ctx).filter((v) => v !== null && v !== "").length);
def("SEQUENCE", 1, 2, ([n, start], ctx) => {
  const count = intArg(n, "SEQUENCE length", FORMULA_LIMITS.maxArrayLength);
  ctx.charge(count);
  const from = start === undefined ? 1 : toNumber(start);
  return Array.from({ length: count }, (_, i) => from + i);
});

/** Key under which the registry stores one lookup value. Typed so "1" and 1 stay different. */
export function lookupValueKey(value: unknown): string {
  return `${typeof value}:${JSON.stringify(value ?? null)}`;
}

def("LOOKUP", 4, 5, ([table, value, lookupColumn, returnColumn, fallback], ctx) => {
  const registry = ctx.options.lookups;
  const entries = registry?.[lookupSignature(toText(table), toText(lookupColumn), toText(returnColumn))];
  if (entries instanceof LookupFailure) throw new FormulaError(entries.reason, entries.code);
  // A caller that resolves lookups passes a registry. A call it did not resolve is a failure, not an empty source.
  if (registry && !entries) throw new FormulaError(`LOOKUP source "${toText(table)}" was not loaded`, "LOOKUP");
  const miss = fallback === undefined ? null : fallback;
  if (!entries || value === null || value === "") return miss;
  const key = lookupValueKey(value);
  const hit = entries instanceof Map ? entries.get(key) : Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : undefined;
  if (hit === undefined) return miss;
  return hit === null || hit === "" ? miss : toValue(hit);
});

/* ------------------------------------------------------- rounding and flow */

function roundAway(value: number, digits: FormulaValue | undefined, direction: "up" | "down"): number {
  const d = digits === undefined ? 0 : Math.max(-15, Math.min(15, Math.trunc(toNumber(digits))));
  const factor = 10 ** d;
  // toPrecision(15) drops binary noise, so 1.1 * 100 does not become 110.00000000000001 and round up to 111.
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const whole = direction === "up" ? Math.ceil(scaled) : Math.floor(scaled);
  return finite((Math.sign(value) * whole) / factor);
}
// ROUNDUP rounds away from zero, ROUNDDOWN toward zero. Text that is not a number gives an error.
def("ROUNDUP", 1, 2, ([v, digits]) => roundAway(toNumber(v), digits, "up"));
def("ROUNDDOWN", 1, 2, ([v, digits]) => roundAway(toNumber(v), digits, "down"));

// IFS(test1, value1, test2, value2, ...) returns the value of the first true test. An odd argument count
// or no true test is an error, so a missing default shows up instead of a silent blank.
defLazy("IFS", 2, FORMULA_LIMITS.maxArgs, (args, ctx) => {
  if (args.length % 2 !== 0) throw new FormulaError("IFS takes pairs of a test and a value");
  for (let i = 0; i < args.length; i += 2) if (truthy(ctx.evaluate(args[i]))) return ctx.evaluate(args[i + 1]);
  throw new FormulaError("IFS found no true test. End with TRUE, value for a default");
});

// SWITCH(value, case1, result1, ..., [default]) compares with ==. No match and no default is an error.
defLazy("SWITCH", 3, FORMULA_LIMITS.maxArgs, (args, ctx) => {
  const subject = ctx.evaluate(args[0]);
  const rest = args.slice(1);
  const hasDefault = rest.length % 2 === 1;
  const pairs = hasDefault ? rest.length - 1 : rest.length;
  for (let i = 0; i < pairs; i += 2) if (looseEquals(subject, ctx.evaluate(rest[i]))) return ctx.evaluate(rest[i + 1]);
  if (hasDefault) return ctx.evaluate(rest[rest.length - 1]);
  throw new FormulaError("SWITCH found no matching case and has no default");
});

// ISERROR(x) is true when evaluating x fails on the data (division by zero, bad number, a missing LOOKUP source). Limit and clock errors propagate.
defLazy("ISERROR", 1, 1, (args, ctx) => {
  try {
    ctx.evaluate(args[0]);
    return false;
  } catch (error) {
    if (error instanceof FormulaError && error.kind === "data") return true;
    throw error;
  }
});

/* -------------------------------------------------------------- structured */

const quoted = (value: FormulaValue): string => {
  const text = toText(value);
  return `"${text.length > 30 ? `${text.slice(0, 30)}...` : text}"`;
};

// INDEX(list, n) is 1-based. n past the end gives blank; n below 1, a non-integer or a non-list is an error.
def("INDEX", 2, 2, ([list, position]) => {
  if (!Array.isArray(list)) throw new FormulaError("INDEX needs a list as its first argument");
  const n = toNumber(position);
  if (!Number.isInteger(n) || n < 1) throw new FormulaError("INDEX position must be a whole number from 1");
  const item = list[n - 1];
  return item === undefined ? null : item;
});

type PathSegment = string | number;

/** `a.b[0].c`, `[2]` and a leading `$` or `$.` are accepted. Anything else is a syntax error. */
function parseJsonPath(path: string): PathSegment[] {
  if (path.length > FORMULA_LIMITS.maxJsonPathLength) throw new FormulaError(`JSON_VALUE path is longer than ${FORMULA_LIMITS.maxJsonPathLength} characters`);
  const segments: PathSegment[] = [];
  let i = path.startsWith("$") ? 1 : 0;
  if (path[i] === ".") i += 1;
  while (i < path.length) {
    if (segments.length >= FORMULA_LIMITS.maxJsonPathSegments) throw new FormulaError(`JSON_VALUE path has more than ${FORMULA_LIMITS.maxJsonPathSegments} parts`);
    if (path[i] === "[") {
      const close = path.indexOf("]", i);
      const digits = close === -1 ? "" : path.slice(i + 1, close);
      if (!/^\d{1,9}$/.test(digits)) throw new FormulaError("JSON_VALUE index must look like [0]");
      segments.push(Number(digits));
      i = close + 1;
    } else {
      let j = i;
      while (j < path.length && path[j] !== "." && path[j] !== "[") j += 1;
      const key = path.slice(i, j);
      if (key === "") throw new FormulaError("JSON_VALUE path has an empty part");
      segments.push(key);
      i = j;
    }
    if (path[i] === ".") {
      i += 1;
      if (i >= path.length || path[i] === "." || path[i] === "[") throw new FormulaError("JSON_VALUE path has an empty part");
    }
  }
  return segments;
}

// JSON_VALUE(cell, "a.b[0]") reads a field out of JSON text. A path that misses gives blank. Blank input gives
// blank. Text that is not JSON, a bad path or a missing path argument is an error. Objects come back as JSON text.
def("JSON_VALUE", 2, 2, ([source, pathArg], ctx) => {
  const segments = parseJsonPath(toText(pathArg).trim());
  let root: unknown;
  if (Array.isArray(source)) {
    root = source;
  } else {
    const text = toText(source).trim();
    if (text === "") return null;
    ctx.charge(Math.ceil(text.length / 1000));
    try {
      root = JSON.parse(text);
    } catch {
      throw new FormulaError("JSON_VALUE needs JSON text");
    }
  }
  ctx.charge(segments.length);
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return null;
      current = current[segment];
    } else {
      if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, segment)) return null;
      current = (current as Record<string, unknown>)[segment];
    }
    if (current === undefined) return null;
  }
  return toValue(current);
});

/* ------------------------------------------------------------------- dates */

function dateArg(value: FormulaValue, label: string, zone: string): CivilDate | null {
  if (value === null || value === "") return null;
  const date = typeof value === "string" ? parseIsoDate(value, zone) : null;
  if (!date) throw new FormulaError(`${label} could not read ${quoted(value)} as an ISO date (2026-03-05)`);
  return date;
}

function clock(ctx: Run, name: string): Date {
  if (!ctx.options.now) throw new FormulaError(`${name} needs the current time, which this evaluation did not provide`, "ERROR", "time");
  return ctx.options.now;
}

// TODAY() is the calendar date in the organization zone as text (2026-03-05). NOW() is the instant as ISO text with the zone's offset.
// Both are volatile: they change on Recalculate and when the row is edited, never on a timer.
def("TODAY", 0, 0, (_args, ctx) => todayIn(clock(ctx, "TODAY"), ctx.zone));
def("NOW", 0, 0, (_args, ctx) => nowIn(clock(ctx, "NOW"), ctx.zone));

// DATE(year, month, day) makes an ISO date. A date that does not exist (30 February, month 13, year 0) is an error.
def("DATE", 3, 3, ([y, m, d]) => {
  const year = Math.trunc(toNumber(y));
  const month = Math.trunc(toNumber(m));
  const day = Math.trunc(toNumber(d));
  if (!isRealDate(year, month, day)) throw new FormulaError(`DATE(${year}, ${month}, ${day}) is not a real date`);
  return formatIsoDate({ year, month, day });
});
// YEAR, MONTH and DAY read ISO text. Blank gives blank, anything else that is not an ISO date is an error.
def("YEAR", 1, 1, ([v], ctx) => dateArg(v, "YEAR", ctx.zone)?.year ?? null);
def("MONTH", 1, 1, ([v], ctx) => dateArg(v, "MONTH", ctx.zone)?.month ?? null);
def("DAY", 1, 1, ([v], ctx) => dateArg(v, "DAY", ctx.zone)?.day ?? null);

// DATEDIF(start, end, "D" | "M" | "Y") counts whole days, complete months or complete years from start to end.
// A blank date gives blank. An end before the start gives a negative number. Any other unit is an error.
def("DATEDIF", 3, 3, ([start, end, unit], ctx) => {
  const u = toText(unit).trim().toUpperCase();
  if (u !== "D" && u !== "M" && u !== "Y") throw new FormulaError('DATEDIF unit must be "D", "M" or "Y"');
  const a = dateArg(start, "DATEDIF", ctx.zone);
  const b = dateArg(end, "DATEDIF", ctx.zone);
  if (!a || !b) return null;
  return dateDiff(a, b, u);
});
