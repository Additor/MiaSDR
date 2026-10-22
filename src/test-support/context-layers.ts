import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Context layers, lowest first. A context may import any context in an earlier entry, never one in its own entry or a later one. */
export const LAYERS: readonly (readonly string[])[] = [
  ["identity"],
  ["tenancy"],
  ["integrations"],
  ["ai"],
  ["people"],
  ["outreach"],
  ["conversations"],
  ["deals", "grid", "analytics"],
];

export const layerOf = (context: string): number => LAYERS.findIndex((layer) => layer.includes(context));

/** Source files under `dir`, tests, test kits and `__tests__` folders (test fixtures) left out. */
export function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__") sourceFiles(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/-test-kit\.ts$/.test(name)) out.push(full);
  }
  return out;
}
