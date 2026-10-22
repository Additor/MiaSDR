import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layerOf, sourceFiles } from "@/test-support/context-layers";

/**
 * Context boundaries. Contexts form layers, and a context imports only contexts in lower layers, so the graph has no
 * cycle. A call that would point upward goes through a port the lower context declares, and `src/composition` wires
 * the implementation in; routes may import `src/composition`, no context does. Test files stay out: they wire real
 * ports from other contexts on purpose.
 */


const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

/** Every module specifier a file names: static and dynamic imports, re-exports and `require`. */
export function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g)) found.push(match[1]);
  return found;
}

/** The specifier as a path under src (`contexts/deals/...`), or null for a package. */
export function target(file: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return specifier.slice(2);
  if (!specifier.startsWith(".")) return null;
  return path.relative(SRC, path.resolve(path.dirname(file), specifier)).split(path.sep).join("/");
}

/** The imports of `file` whose target starts with one of `forbidden`, as "file -> specifier". */
export function violations(file: string, source: string, forbidden: readonly string[]): string[] {
  return specifiers(source)
    .filter((s) => {
      const t = target(file, s);
      return t !== null && forbidden.some((prefix) => t === prefix || t.startsWith(`${prefix}/`));
    })
    .map((s) => `${path.relative(ROOT, file)} -> ${s}`);
}

const CONTEXT_FORBIDDEN = ["composition"];

/** The imports of `file` (under src/contexts/<context>) that reach a context in the same or a higher layer. */
export function upwardImports(file: string, source: string): string[] {
  const own = path.relative(SRC, file).split(path.sep)[1];
  return specifiers(source)
    .filter((s) => {
      const other = target(file, s)?.match(/^contexts\/([^/]+)/)?.[1];
      return other !== undefined && other !== own && layerOf(other) >= layerOf(own);
    })
    .map((s) => `${path.relative(ROOT, file)} -> ${s}`);
}

/**
 * The tiers under src, lowest first: `shared` (the kernel: errors, env, time, formatting), `platform` (database client,
 * schema barrel, job runtime, files, credentials), the contexts, `composition`, then `app`. A tier imports only lower
 * tiers. `shared` imports no framework or driver either.
 */
const TIER_FORBIDDEN: Record<string, { paths: string[]; packages: RegExp | null }> = {
  shared: { paths: ["contexts", "platform", "composition", "app", "components", "lib", "hooks"], packages: /^(next|react|drizzle-orm|postgres)(\/|$)/ },
  platform: { paths: ["composition", "app", "components", "lib", "hooks"], packages: null },
};

/** Platform files that import a context, as the code stood when the rule arrived. Shrink only. */
const PLATFORM_CONTEXT_IMPORTS: Record<string, string[]> = {
  // The schema barrel: the Drizzle client and migrations see every table through it.
  "src/platform/db/schema.ts": [
    "@/contexts/conversations/after-reply/infrastructure/sequences-schema",
    "@/contexts/conversations/infrastructure/schema",
    "@/contexts/deals/infrastructure/schema",
    "@/contexts/grid/infrastructure/schema",
    "@/contexts/identity/infrastructure/schema",
    "@/contexts/integrations/infrastructure/schema",
    "@/contexts/leads/infrastructure/schema",
    "@/contexts/outreach/infrastructure/schema",
    "@/contexts/tenancy/infrastructure/schema",
  ],
  "src/platform/db/columns.ts": ["@/contexts/tenancy/infrastructure/schema"],
};

/** `{ file: specifiers }` of the files under `tier` that import what the tier may not. */
function tierViolations(tier: keyof typeof TIER_FORBIDDEN): string[] {
  const rule = TIER_FORBIDDEN[tier];
  const out: string[] = [];
  for (const file of sourceFiles(path.join(SRC, tier))) {
    const source = readFileSync(file, "utf8");
    out.push(...violations(file, source, rule.paths));
    if (rule.packages) for (const s of specifiers(source)) if (rule.packages.test(s)) out.push(`${path.relative(ROOT, file)} -> ${s}`);
  }
  return out;
}

describe("tier dependencies", () => {
  it("keeps src/shared free of every tier above it, frameworks and drivers", () => {
    expect(tierViolations("shared")).toEqual([]);
  });

  it("keeps src/platform free of composition, app and UI", () => {
    expect(tierViolations("platform")).toEqual([]);
  });

  it("lets src/platform import a context only where the shrink-only list allows it", () => {
    const found: Record<string, string[]> = {};
    for (const file of sourceFiles(path.join(SRC, "platform"))) {
      const hits = [...new Set(specifiers(readFileSync(file, "utf8")).filter((s) => target(file, s)?.startsWith("contexts/")))].sort();
      if (hits.length > 0) found[path.relative(ROOT, file).split(path.sep).join("/")] = hits;
    }
    expect(found).toEqual(PLATFORM_CONTEXT_IMPORTS);
  });
});

describe("context dependencies", () => {
  it("places every context in a layer", () => {
    const contexts = readdirSync(path.join(SRC, "contexts")).filter((name) => statSync(path.join(SRC, "contexts", name)).isDirectory());
    expect(contexts.filter((c) => layerOf(c) === -1)).toEqual([]);
  });

  it("imports only contexts in lower layers", () => {
    const files = sourceFiles(path.join(SRC, "contexts"));
    expect(files.flatMap((f) => upwardImports(f, readFileSync(f, "utf8")))).toEqual([]);
  });

  it("flags an import into the same layer or upward", () => {
    const file = path.join(SRC, "contexts/outreach/infrastructure/example.ts");
    const source = [
      'import { receiveInbound } from "@/contexts/conversations/infrastructure/composition";',
      'import type { Role } from "../../tenancy/domain/roles";',
      'import { own } from "./own";',
    ].join("\n");
    expect(upwardImports(file, source)).toEqual(["src/contexts/outreach/infrastructure/example.ts -> @/contexts/conversations/infrastructure/composition"]);
  });

  it("keeps every context free of the composition root", () => {
    const files = sourceFiles(path.join(SRC, "contexts"));
    expect(files.flatMap((f) => violations(f, readFileSync(f, "utf8"), CONTEXT_FORBIDDEN))).toEqual([]);
  });

  it("catches an alias, a relative, a dynamic and a type-only import", () => {
    const file = path.join(SRC, "contexts/leads/application/example.ts");
    const source = [
      'import { deals } from "@/contexts/deals/application/deals";',
      'import type { Port } from "../../outreach/application/ports";',
      'const root = await import("@/composition/person-lifecycle");',
      'export * from "../../deals/domain/deal";',
      'import { ok } from "@/contexts/conversations/infrastructure/person-handling";',
      'import { sql } from "drizzle-orm";',
    ].join("\n");
    expect(upwardImports(file, source)).toEqual([
      "src/contexts/leads/application/example.ts -> @/contexts/deals/application/deals",
      "src/contexts/leads/application/example.ts -> ../../outreach/application/ports",
      "src/contexts/leads/application/example.ts -> ../../deals/domain/deal",
      "src/contexts/leads/application/example.ts -> @/contexts/conversations/infrastructure/person-handling",
    ]);
    expect(violations(file, source, CONTEXT_FORBIDDEN)).toEqual(["src/contexts/leads/application/example.ts -> @/composition/person-lifecycle"]);
  });
});
