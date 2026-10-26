import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The public surface of a context for UI code: `src/app`, `src/components`, `src/hooks` and `src/lib`. Pages and route handlers import a context's `domain/` and
 * `application/` freely, but from `infrastructure/` only its composition files (`composition.ts`, `*-composition.ts`),
 * which hand out wired deps, plus the identity entry points below. Everything else in `infrastructure/` is private, so
 * a context can rename or split a store without touching a route.
 */

/** Identity's auth entry points: the session readers, the Better Auth handler and client, and the sign-up facts. */
const PUBLIC_INFRASTRUCTURE = new Set(["identity/infrastructure/session", "identity/infrastructure/auth-client", "identity/infrastructure/auth", "identity/infrastructure/signup-facts"]);

/** UI files that still import a private infrastructure module, as the code stood when the rule arrived. Shrink only. */
const PRIVATE_IMPORTS: Record<string, string[]> = {
  "src/app/api/dev/inbound/route.ts": ["outreach/email/infrastructure/fake-mailbox-provider"],
  "src/app/api/grid/tables/[tableId]/import/route.ts": ["grid/infrastructure/parse-upload"],
  "src/app/api/webhooks/dev-fakes/route.ts": ["identity/infrastructure/e2e-rate-limit", "outreach/email/infrastructure/fake-mailbox-provider", "outreach/linkedin/infrastructure/fake-linkedin-gateway"],
};

const ROOT = path.resolve(__dirname, "../..");

function appFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) appFiles(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** The private infrastructure modules `source` imports, as `<context>[/<subdomain>]/infrastructure/<module>`. */
export function privateImports(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']@\/contexts\/([a-z]+(?:\/[a-z-]+)?\/infrastructure\/[a-z0-9/-]+)["']/g)) {
    const imported = m[1];
    if (/(^|-)composition$/.test(imported.split("/").pop() ?? "") || PUBLIC_INFRASTRUCTURE.has(imported)) continue;
    found.add(imported);
  }
  return [...found].sort();
}

describe("app boundaries", () => {
  it("imports private infrastructure only where the shrink-only list allows it", () => {
    const found: Record<string, string[]> = {};
    for (const file of ["src/app", "src/components", "src/hooks", "src/lib"].flatMap((dir) => appFiles(path.join(ROOT, dir)))) {
      const hits = privateImports(readFileSync(file, "utf8"));
      if (hits.length > 0) found[path.relative(ROOT, file).split(path.sep).join("/")] = hits;
    }
    expect(found).toEqual(PRIVATE_IMPORTS);
  });

  it("tells a composition and an entry point from a private module", () => {
    const source = [
      'import { mailboxDeps } from "@/contexts/outreach/infrastructure/composition";',
      'import { linkedinJobs } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";',
      'import { requireOrgContext } from "@/contexts/identity/infrastructure/session";',
      'import { drizzleLeadStore } from "@/contexts/people/infrastructure/drizzle-lead-store";',
      'const q = await import("@/contexts/people/infrastructure/queries");',
      'import { VENDORS } from "@/contexts/grid/enrichment/infrastructure/vendors/index";',
    ].join("\n");
    expect(privateImports(source)).toEqual(["grid/enrichment/infrastructure/vendors/index", "people/infrastructure/drizzle-lead-store", "people/infrastructure/queries"]);
  });
});
