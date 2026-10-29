import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SEND_STATUSES } from "@/contexts/outreach/domain/send-status";
import { sourceFiles } from "./context-layers";

/**
 * Numbers and sets the outreach domain owns appear once. The send attempt cap is `MAX_SEND_ATTEMPTS`
 * (`outreach/domain/send-policy.ts`), which only `scheduleRetry` compares, so no claim query, store write or database
 * rule repeats it. A set of `sends.status` values is a named constant of `outreach/domain/send-status.ts`, so a store
 * that counts or filters sends reads the same list the engines use.
 */

const ROOT = path.resolve(__dirname, "../..");
const files = [...sourceFiles(path.join(ROOT, "src/contexts")), ...sourceFiles(path.join(ROOT, "src/platform"))];
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

/** Where a pattern matches, as "file: matched text", so an entry survives edits elsewhere in the file. */
function hits(patterns: RegExp[], skip: (file: string) => boolean = () => false): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (skip(rel(file))) continue;
    const source = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) found.push(`${rel(file)}: ${match[0]}`);
    }
  }
  return [...new Set(found)].sort();
}

/** A comparison of an attempt number with a literal, or an attempt number written as a literal. */
const CAP_LITERALS = [/\battempt\s*(?:<|<=|>|>=)\s*\d/g, /\battempt:\s*\d/g];

/** Literal attempt comparisons that are not the send cap. Shrink-only: an entry leaves when its code goes. */
const CAP_ALLOWED: Record<string, string> = {
  "src/contexts/grid/application/formula-management.ts: attempt < 2": "A loop counter: the formula author gets a second try with feedback on the first.",
  "src/contexts/outreach/infrastructure/contact-guard.ts: attempt >= 2": "A loop counter: an enrollment insert that raced a person becoming a contact retries twice without that person.",
};

/** A status filter over the sends table written out: raw SQL on `sends` or `${sends.status}`, or a Drizzle helper on `sends.status`. */
const SENDS_STATUS_LITERALS = [
  /\bsends\.status\s+(?:not\s+)?in\s*\(\s*'/g,
  /\$\{sends\.status\}\s+(?:not\s+)?in\s*\(\s*'/g,
  /(?:inArray|notInArray)\(sends\.status,\s*\[\s*["']/g,
];

/**
 * A literal list of two or more statuses, each one a send status, on any alias (`s.status in ('sent', 'unknown')`,
 * `inArray(x.status, ["sending", "sent"])`). Lists that mix in other tables' statuses (drafts, send attempts) pass.
 */
const ANY_STATUS_LIST = [/\b\w+\.status\}?\s+(?:not\s+)?in\s*\(([^)]*)\)/g, /(?:inArray|notInArray)\(\w+\.status,\s*\[([^\]]*)\]/g];

function sendStatusLists(skip: (file: string) => boolean): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (skip(rel(file))) continue;
    const source = readFileSync(file, "utf8");
    for (const pattern of ANY_STATUS_LIST) {
      for (const match of source.matchAll(pattern)) {
        const items = [...match[1].matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1]);
        if (items.length >= 2 && items.every((item) => (SEND_STATUSES as readonly string[]).includes(item))) found.push(`${rel(file)}: ${match[0]}`);
      }
    }
  }
  return found.sort();
}

const definedHere = (file: string) => file === "src/contexts/outreach/domain/send-status.ts";

describe("domain literals", () => {
  it("keeps the send attempt cap in send-policy.ts alone", () => {
    expect(hits(CAP_LITERALS)).toEqual(Object.keys(CAP_ALLOWED).sort());
  });

  it("filters the sends status column only through the named sets of send-status.ts", () => {
    expect(hits(SENDS_STATUS_LITERALS, definedHere)).toEqual([]);
  });

  it("writes out no list of send statuses under any alias", () => {
    expect(sendStatusLists(definedHere)).toEqual([]);
  });
});
