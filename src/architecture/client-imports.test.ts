import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { disk, resolveSource, specifiersOf, type SourceReader } from "./source-ast";

/**
 * What the browser bundle may load from the server side (docs/decisions.md, "API errors and contract types"). Every
 * module a `"use client"` file reaches through value imports, however many modules deep, ships to the browser. Of
 * `src/contexts` it may reach `domain/` and leaf `application/` modules; of the rest only `src/shared`, `src/app`,
 * `src/components` and packages. A leaf loads nothing at run time but `domain/` and `src/shared` modules: a limit, a
 * sentence, a pure check. A type import is free, since the compiler erases it.
 *
 * `next build` checks the result: no client chunk holds drizzle or postgres (docs/operations.md).
 */

const ROOT = path.resolve(__dirname, "../..");

/** Server modules the browser may load, each with its reason. Shrink only. */
const CLIENT_SERVER_MODULES: Record<string, string> = {
  "src/contexts/identity/infrastructure/auth-client.ts": "Better Auth's browser client for the sign-in, sign-up and account screens. It loads `better-auth/react` and no database code.",
};

/** Packages that hold a database driver or query builder. No client module may load one. */
const DATABASE_PACKAGES = /^(drizzle-orm|postgres|pg)(\/|$)/;

const posix = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(posix(full));
  }
  return out;
}

const isClientEntry = (text: string) => /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(text);

const isDomain = (file: string) => /^src\/contexts\/.+\/domain\//.test(file);
const isShared = (file: string) => file.startsWith("src/shared/");
const isApplication = (file: string) => /^src\/contexts\/.+\/application\//.test(file);

/** Why an application module is not a leaf, or null when it is one. */
function notLeaf(file: string, reader: SourceReader): string | null {
  for (const specifier of specifiersOf(file, reader)) {
    const target = resolveSource(file, specifier, reader);
    if (!target) return `loads the package ${specifier}`;
    if (!isDomain(target) && !isShared(target)) return `loads ${target}`;
  }
  return null;
}

/** Each server module the client graph reaches against the rule, with the import chain from a client entry. */
export function clientReach(entries: string[], reader: SourceReader): Record<string, string> {
  const found: Record<string, string> = {};
  const seen = new Set(entries);
  const queue = entries.map((file) => ({ file, chain: [file] }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const specifier of specifiersOf(current.file, reader)) {
      const target = resolveSource(current.file, specifier, reader);
      if (!target) {
        if (DATABASE_PACKAGES.test(specifier)) found[`${current.file} loads ${specifier}`] ??= current.chain.join(" -> ");
        continue;
      }
      if (seen.has(target)) continue;
      seen.add(target);
      const chain = [...current.chain, target];
      if (target in CLIENT_SERVER_MODULES) continue;
      const leafProblem = isApplication(target) ? notLeaf(target, reader) : null;
      if (leafProblem) found[`${target} is not a leaf: it ${leafProblem}`] = chain.join(" -> ");
      else if (target.startsWith("src/contexts/") && !isDomain(target) && !isApplication(target)) found[target] = chain.join(" -> ");
      else if (target.startsWith("src/platform/") || target.startsWith("src/composition/")) found[target] = chain.join(" -> ");
      else queue.push({ file: target, chain });
    }
  }
  return found;
}

/** Files that call `fetch` themselves, each with its reason. Every other browser call goes through `callApi`. Shrink only. */
const RAW_FETCH: Record<string, string> = {
  "src/app/_lib/api-client.ts": "`callApi` itself.",
  "src/app/(app)/crm/contacts/_components/contacts-bulk-bar.tsx": "Export selected downloads the CSV as a blob; `callApi` reads JSON.",
  "src/app/(app)/tables/_components/table-workspace.tsx": "Export downloads the CSV as a blob; `callApi` reads JSON.",
};

describe("client imports", () => {
  it("calls the API through callApi everywhere but the listed files", () => {
    const found: Record<string, string> = {};
    for (const file of ["src/app", "src/components"].flatMap((dir) => sourceFiles(path.join(ROOT, dir)))) {
      if (file.startsWith("src/app/api/")) continue;
      if (/\bfetch\(/.test(disk.read(file))) found[file] = RAW_FETCH[file] ?? "(not listed: call the API through callApi)";
    }
    expect(found).toEqual(RAW_FETCH);
  });

  it("loads from the server side only domain modules, leaf application modules and the listed modules", () => {
    const entries = ["src/app", "src/components"].flatMap((dir) => sourceFiles(path.join(ROOT, dir))).filter((file) => isClientEntry(disk.read(file)));
    expect(entries.length).toBeGreaterThan(100);
    expect(clientReach(entries, disk)).toEqual({});
  }, 60_000);

  it("follows a helper, refuses an application module that loads a store and lets a type import pass", () => {
    const sample: Record<string, string> = {
      "src/app/x/a.tsx": '"use client";\nimport { helper } from "./helper";\nimport type { Deps } from "@/contexts/people/application/lead-ports";\nexport const A = helper;',
      "src/app/x/helper.ts": 'import { LIMIT } from "@/contexts/people/application/limits-sample";\nimport { busy } from "@/contexts/people/application/busy-sample";\nexport const helper = [LIMIT, busy];',
      "src/contexts/people/application/limits-sample.ts": 'import { isUuid } from "../domain/uuid-sample";\nexport const LIMIT = isUuid;',
      "src/contexts/people/domain/uuid-sample.ts": "export const isUuid = () => true;",
      "src/contexts/people/application/busy-sample.ts": 'import { retryOnce } from "@/platform/db/errors";\nexport const busy = retryOnce;',
      "src/app/x/b.tsx": '"use client";\nimport { sql } from "drizzle-orm";\nimport { db } from "@/platform/db/client";\nexport const B = [sql, db];',
    };
    const reader: SourceReader = { read: (file) => sample[file] ?? disk.read(file), exists: (file) => file in sample || disk.exists(file) };
    expect(clientReach(["src/app/x/a.tsx", "src/app/x/b.tsx"], reader)).toEqual({
      "src/contexts/people/application/busy-sample.ts is not a leaf: it loads src/platform/db/errors.ts": "src/app/x/a.tsx -> src/app/x/helper.ts -> src/contexts/people/application/busy-sample.ts",
      "src/app/x/b.tsx loads drizzle-orm": "src/app/x/b.tsx",
      "src/platform/db/client.ts": "src/app/x/b.tsx -> src/platform/db/client.ts",
    });
    expect(isClientEntry('/** A note. */\n"use client";\n')).toBe(true);
    expect(isClientEntry('import x from "y";\n"use client";\n')).toBe(false);
  });
});
