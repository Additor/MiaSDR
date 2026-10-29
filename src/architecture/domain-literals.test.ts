import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

/** A raw SQL `in` list or a Drizzle `inArray` over the sends status column, written out instead of taken from send-status.ts. */
const STATUS_SET_LITERALS = [/\bs\.status\s+in\s*\(\s*'/g, /\bsends\.status\s+in\s*\(\s*'/g, /inArray\(sends\.status,\s*\[\s*["']/g];

describe("domain literals", () => {
  it("keeps the send attempt cap in send-policy.ts alone", () => {
    expect(hits(CAP_LITERALS)).toEqual(Object.keys(CAP_ALLOWED).sort());
  });

  it("names every set of send statuses in send-status.ts", () => {
    expect(hits(STATUS_SET_LITERALS, (file) => file === "src/contexts/outreach/domain/send-status.ts")).toEqual([]);
  });
});
