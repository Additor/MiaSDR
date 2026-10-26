import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";

/**
 * Status columns with a transition table in a domain module. Every statement that sets one of them names the source
 * statuses it moves from, so a late or concurrent writer changes nothing. A Drizzle update needs a guard helper or an
 * `eq`/`inArray` on the status column in the same statement; a raw SQL update needs `status in` or `status =`.
 */
const GUARDED: Array<{ table: string; drizzle: RegExp; raw: RegExp; guard: RegExp }> = [
  {
    table: "drafts",
    drizzle: /\.update\(drafts\)/g,
    raw: /update drafts set status/g,
    guard: /draftCanBecome\(|draftIn\(|(eq|inArray)\(drafts\.status|status in \$\{|status = '/,
  },
  {
    table: "campaign_enrollments",
    drizzle: /\.update\(campaignEnrollments\)/g,
    raw: /update campaign_enrollments( e)? set status/g,
    guard: /(eq|inArray)\(campaignEnrollments\.status|status in \$\{|status = '/,
  },
];

const ROOT = path.resolve(__dirname, "../..");
const files = [...sourceFiles(path.join(ROOT, "src/contexts")), ...sourceFiles(path.join(ROOT, "src/platform"))];

/** The statement that starts at `index`: up to the first `;` outside a template literal's `${...}`. */
function statementAt(source: string, index: number): string {
  let depth = 0;
  for (let i = index; i < source.length; i++) {
    const c = source[i];
    if (c === "{" ) depth++;
    else if (c === "}") depth--;
    else if (c === ";" && depth <= 0) return source.slice(index, i);
  }
  return source.slice(index);
}

describe("status guards", () => {
  for (const rule of GUARDED) {
    it(`every write of ${rule.table}.status names the statuses it moves from`, () => {
      const unguarded: string[] = [];
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const pattern of [rule.drizzle, rule.raw]) {
          for (const match of source.matchAll(pattern)) {
            const statement = statementAt(source, match.index);
            const setsStatus = pattern === rule.raw || /\.set\(\{[^}]*\bstatus:/.test(statement);
            if (setsStatus && !rule.guard.test(statement)) {
              unguarded.push(`${path.relative(ROOT, file)}:${source.slice(0, match.index).split("\n").length}`);
            }
          }
        }
      }
      expect(unguarded).toEqual([]);
    });
  }
});
