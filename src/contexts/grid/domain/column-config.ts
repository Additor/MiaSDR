import { ValidationError } from "@/shared/errors";
import { cleanJson } from "./cell-values";
import type { ColumnType } from "./column-types";

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

/** Validates a data column's config for its type. The module that runs a runner column checks that column's config. */
export function prepareColumnConfig(type: ColumnType, rawConfig: unknown): Record<string, unknown> {
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

  return config;
}

/** Throws when giving `candidate` these dependencies would close a loop. Columns that read each other would queue paid runs forever. */
export function assertNoDependencyLoop(columns: ReadonlyArray<{ key: string; name: string; dependsOn: readonly string[] }>, candidate: { key: string; dependsOn: readonly string[] }): void {
  const graph = new Map<string, readonly string[]>(columns.map((c) => [c.key, c.dependsOn]));
  graph.set(candidate.key, candidate.dependsOn);
  const nameOf = (key: string) => columns.find((c) => c.key === key)?.name ?? key;
  const seen = new Set<string>();
  const reaches = (key: string): boolean => {
    if (key === candidate.key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return (graph.get(key) ?? []).some(reaches);
  };
  const loop = candidate.dependsOn.find(reaches);
  if (loop) throw new ValidationError(`${nameOf(candidate.key)} and ${nameOf(loop)} would read each other, so their runs would never finish. Choose another input.`);
}
