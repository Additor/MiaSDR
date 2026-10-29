import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { disk, resolveSource as resolve, specifiersOf, type SourceReader } from "./source-ast";

/**
 * Route handlers read the session through `withActor`, `withUser` or `withAdmin` (src/app/_lib/api.ts), so they answer 401
 * and the application errors in the one shape the client reads. The session readers (`apiOrgContext`, `apiUser`,
 * `requireOrgContext`, `resolveOrgContext`) live in identity's `session.ts`; `getSession` is on Better Auth's `auth()`.
 *
 * The rule is on imports, so an alias or a reader passed as a value does not slip past it:
 * - no file under src/app/api or src/app/_lib, and no `route.ts` elsewhere in src/app, imports the Better Auth module
 *   (`identity/infrastructure/auth`) or a `better-auth` entry point other than `better-auth/crypto`;
 * - none of them reaches `session.ts` through its imports, however many modules deep, except through `_lib/api.ts`.
 */

const ROOT = path.resolve(__dirname, "../..");
const SESSION = "src/contexts/identity/infrastructure/session.ts";
const AUTH = "src/contexts/identity/infrastructure/auth.ts";
/** The wrappers themselves. The walk stops here: a handler that goes through them is the point of the rule. */
const WRAPPERS = "src/app/_lib/api.ts";

/** Files that read the session or Better Auth themselves, each with its reason. Shrink only. */
const READS_SESSION_ITSELF: Record<string, string> = {
  "src/app/(legacy)/crm/records/[id]/route.ts": "A redirect for old record links, outside /api. Without a session it sends the browser to the Pipeline; a wrapper would answer 401 JSON to a link.",
  "src/app/(legacy)/crm/sequences/[id]/route.ts": "A redirect for old sequence links, outside /api. Without a session it sends the browser to the campaign list; a wrapper would answer 401 JSON to a link.",
  "src/app/api/auth/[...all]/route.ts": "Better Auth's own endpoints (sign-in, sign-up, reset), a public route. It hands the request to the Better Auth handler.",
  "src/app/api/invitations/[id]/route.ts": "GET is the accept-invitation page's data, for a signed-in user who usually has no organization yet. The view depends on the session's email, which `withUser` does not hand over (`SessionUser` carries no email), so it reads the Better Auth session itself. DELETE uses `withActor`.",
};

const posix = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

function sourceFiles(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, keep, out);
    else if (keep(name)) out.push(posix(full));
  }
  return out;
}

const isSource = (name: string) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);

/** The files the rule covers: every source file under src/app/api and src/app/_lib, and every route.ts in src/app. */
function scannedFiles(): string[] {
  const files = new Set([
    ...sourceFiles(path.join(ROOT, "src/app/api"), isSource),
    ...sourceFiles(path.join(ROOT, "src/app/_lib"), isSource),
    ...sourceFiles(path.join(ROOT, "src/app"), (name) => name === "route.ts"),
  ]);
  files.delete(WRAPPERS);
  return [...files].sort();
}

/** Better Auth's hashing helpers read no session; every other entry point can. */
const HARMLESS_BETTER_AUTH = new Set(["better-auth/crypto"]);
const isBetterAuth = (specifier: string) => (specifier === "better-auth" || specifier.startsWith("better-auth/")) && !HARMLESS_BETTER_AUTH.has(specifier);

/** Why a file breaks the rule, or null. Imports are followed through src; the walk stops at the wrappers. */
export function sessionReach(file: string, reader: SourceReader): string | null {
  for (const specifier of specifiersOf(file, reader)) {
    if (isBetterAuth(specifier) || resolve(file, specifier, reader) === AUTH) return `imports ${specifier}`;
  }
  const seen = new Set([file]);
  const queue: Array<{ file: string; chain: string[] }> = [{ file, chain: [] }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const specifier of specifiersOf(current.file, reader)) {
      const target = resolve(current.file, specifier, reader);
      if (!target || target === WRAPPERS || seen.has(target)) continue;
      const chain = [...current.chain, target];
      if (target === SESSION) return `reaches the session readers: ${[file, ...chain].join(" -> ")}`;
      seen.add(target);
      queue.push({ file: target, chain });
    }
  }
  return null;
}

describe("route wrappers", () => {
  it("leaves the session to withActor, withUser or withAdmin everywhere but the listed files", () => {
    const found: Record<string, string> = {};
    for (const file of scannedFiles()) {
      const reach = sessionReach(file, disk);
      if (reach) found[file] = READS_SESSION_ITSELF[file] ?? `(not listed: ${reach}. Wrap the handler in withActor, withUser or withAdmin)`;
    }
    expect(found).toEqual(READS_SESSION_ITSELF);
  }, 60_000);

  it("catches an aliased import, a sibling helper, a dynamic import and Better Auth, and lets a wrapper or a type import pass", () => {
    const sample: Record<string, string> = {
      "src/app/api/x/route.ts": 'import { apiOrgContext as who } from "@/contexts/identity/infrastructure/session";\nexport const GET = () => who();',
      "src/app/api/y/route.ts": 'import { readCaller } from "./read-caller";\nexport const GET = () => readCaller();',
      "src/app/api/y/read-caller.ts": 'import * as s from "../../../contexts/identity/infrastructure/session";\nexport const readCaller = s.apiUser;',
      "src/app/api/z/route.ts": 'export const GET = async () => (await import("@/contexts/identity/infrastructure/session")).apiOrgContext();',
      "src/app/api/b/route.ts": 'import { auth } from "@/contexts/identity/infrastructure/auth";\nexport const GET = () => auth();',
      "src/app/api/c/route.ts": 'import { getSessionCookie } from "better-auth/cookies";\nexport const GET = getSessionCookie;',
      "src/app/api/ok/route.ts": 'import { withActor } from "@/app/_lib/api";\nimport type { OrgContext } from "@/contexts/identity/infrastructure/session";\nexport const GET = () => withActor(async () => ({ ok: true }));',
    };
    const reader: SourceReader = { read: (file) => sample[file] ?? disk.read(file), exists: (file) => file in sample || disk.exists(file) };
    const reach = (file: string) => sessionReach(file, reader);
    expect(reach("src/app/api/x/route.ts")).toBe("reaches the session readers: src/app/api/x/route.ts -> src/contexts/identity/infrastructure/session.ts");
    expect(reach("src/app/api/y/route.ts")).toBe("reaches the session readers: src/app/api/y/route.ts -> src/app/api/y/read-caller.ts -> src/contexts/identity/infrastructure/session.ts");
    expect(reach("src/app/api/z/route.ts")).toMatch(/^reaches the session readers/);
    expect(reach("src/app/api/b/route.ts")).toBe("imports @/contexts/identity/infrastructure/auth");
    expect(reach("src/app/api/c/route.ts")).toBe("imports better-auth/cookies");
    expect(reach("src/app/api/ok/route.ts")).toBeNull();
  });
});
