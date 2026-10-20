import { ValidationError } from "@/shared/errors";
import { cleanJson } from "./cell-values";
import { isStaticColumnType, type ColumnType } from "./column-types";
import { compileFormula } from "./formula";
import { TOKEN, normalizeKey } from "./keys";

export const MAX_COLUMNS_PER_TABLE = 200;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_CONFIG_DEPTH = 12;


export const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function depthOf(value: unknown, limit: number, depth = 0): number {
  if (depth > limit || value === null || typeof value !== "object") return depth;
  let max = depth;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    max = Math.max(max, depthOf(child, limit, depth + 1));
    if (max > limit) return max;
  }
  return max;
}

/** Rejects configs that are not plain JSON objects of reasonable size, then strips characters jsonb refuses. */
export function sanitizeConfig(config: unknown): Record<string, unknown> {
  if (!isPlainObject(config)) throw new ValidationError("Column config must be an object");
  if (depthOf(config, MAX_CONFIG_DEPTH) > MAX_CONFIG_DEPTH) throw new ValidationError("Column config is nested too deeply");
  const cleaned = cleanJson(config);
  if (JSON.stringify(cleaned).length > MAX_CONFIG_BYTES) throw new ValidationError("Column config is too large");
  return cleaned;
}

/** Column keys a runner config reads: {{key}} tokens in any string, plus columnKey and sourceColumnKey properties. */
export function configDependencies(config: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  const stack: unknown[] = [config];
  let visited = 0;
  while (stack.length > 0 && visited < 10_000) {
    visited += 1;
    const value = stack.pop();
    if (typeof value === "string") {
      for (const match of value.matchAll(TOKEN)) keys.add(normalizeKey(match[1]));
    } else if (Array.isArray(value)) {
      stack.push(...value);
    } else if (isPlainObject(value)) {
      for (const [name, child] of Object.entries(value)) {
        if ((name === "columnKey" || name === "sourceColumnKey") && typeof child === "string" && child) keys.add(child);
        stack.push(child);
      }
    }
  }
  return [...keys];
}

export interface PreparedConfig {
  config: Record<string, unknown>;
  dependsOn: string[];
}

/**
 * Validates a column's config for its type and works out which columns it reads.
 * Static types check their own shape. A formula must parse. Other runner types
 * (enrichment, ai, http and so on) keep a size-limited object here; the module
 * that runs them registers a hook for stricter checks.
 */
export function prepareColumnConfig(type: ColumnType, rawConfig: unknown, siblingKeys: ReadonlySet<string>, ownKey: string | null): PreparedConfig {
  const config = sanitizeConfig(rawConfig ?? {});

  if (type === "select" || type === "multiselect") {
    const options = config.options;
    const valid = (o: unknown) =>
      typeof o === "string" ||
      (isPlainObject(o) && typeof o.value === "string" && (o.label === undefined || typeof o.label === "string") && (o.color === undefined || typeof o.color === "string"));
    if (options !== undefined && (!Array.isArray(options) || options.length > 500 || !options.every(valid))) {
      throw new ValidationError("Options must be a list of up to 500 text values");
    }
  }
  if (type === "currency" && config.currency !== undefined && (typeof config.currency !== "string" || config.currency.length > 8)) {
    throw new ValidationError("Currency must be a currency code like USD");
  }

  let dependsOn: string[] = [];
  if (type === "formula") {
    if (typeof config.expression !== "string" || !config.expression.trim()) throw new ValidationError("Formula expression is required");
    const compiled = compileFormula(config.expression);
    if (!compiled.ok) throw new ValidationError(compiled.error);
    const unknown = compiled.formula.references.cells.find((key) => !siblingKeys.has(key) || key === ownKey);
    if (unknown) throw new ValidationError(`The formula references an unknown column "${unknown}"`);
    dependsOn = compiled.formula.references.cells;
  } else if (!isStaticColumnType(type)) {
    dependsOn = configDependencies(config).filter((key) => key !== ownKey);
  }
  return { config, dependsOn };
}

/** Throws when giving `candidate` these dependencies would close a loop. A cycle would queue cells forever. */
export function assertNoCycle(columns: ReadonlyArray<{ key: string; dependsOn: readonly string[] }>, candidate: { key: string; dependsOn: readonly string[] }): void {
  const graph = new Map<string, readonly string[]>();
  for (const c of columns) if (c.key !== candidate.key) graph.set(c.key, c.dependsOn);
  graph.set(candidate.key, candidate.dependsOn);

  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string, path: string[]): void => {
    const s = state.get(key);
    if (s === "done") return;
    if (s === "visiting") throw new ValidationError(`Circular dependency: ${[...path.slice(path.indexOf(key)), key].join(" > ")}`);
    state.set(key, "visiting");
    for (const dep of graph.get(key) ?? []) visit(dep, [...path, key]);
    state.set(key, "done");
  };
  for (const key of graph.keys()) visit(key, []);
}

/** Columns ordered so each one follows everything it depends on. A dependency on a missing column counts as constant. */
export function topologicalOrder<T extends { key: string; dependsOn: readonly string[] }>(columns: readonly T[]): T[] {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const state = new Map<string, "visiting" | "done">();
  const out: T[] = [];
  const visit = (key: string): void => {
    if (state.get(key) === "done") return;
    if (state.get(key) === "visiting") throw new ValidationError(`Circular dependency at "${key}"`);
    const column = byKey.get(key);
    if (!column) return;
    state.set(key, "visiting");
    for (const dep of column.dependsOn) visit(dep);
    state.set(key, "done");
    out.push(column);
  };
  for (const c of columns) visit(c.key);
  return out;
}
