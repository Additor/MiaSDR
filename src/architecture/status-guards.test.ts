import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";

/**
 * Status columns with a transition table in a domain module. Every statement that sets one of them names the source
 * statuses it moves from, so a late or concurrent writer changes nothing. A Drizzle update needs a guard helper or an
 * `eq`/`inArray` on the status column in the same statement; a raw SQL update needs `status in` or `status =`. A rule
 * with `inWhere` reads the guard from the WHERE clause only, so the status the SET writes does not count as its guard,
 * and its raw pattern also finds a SET that writes `status` after other columns (`set due_at = ..., status = ...`).
 */
const GUARDED: Array<{ table: string; drizzle: RegExp; raw: RegExp; guard: RegExp; inWhere?: boolean }> = [
  {
    table: "drafts",
    drizzle: /\.update\(drafts\)/g,
    raw: /update drafts set status/g,
    guard: /draftCanBecome\(|draftIn\(|(eq|inArray)\(drafts\.status|status in \$\{|status = '/,
  },
  {
    table: "sends",
    drizzle: /\.update\(sends\)/g,
    raw: /update sends( s)? set status/g,
    guard: /canSend\(|ownClaim\(|readAttempt\(|fromCall|(eq|inArray)\(sends\.status|status in \$\{|status = '/,
  },
  {
    table: "campaign_enrollments",
    drizzle: /\.update\(campaignEnrollments\)/g,
    raw: /update campaign_enrollments( e)? set status/g,
    guard: /(eq|inArray)\(campaignEnrollments\.status|status in \$\{|status = '/,
  },
  {
    table: "sequence_runs",
    drizzle: /\.update\(sequenceRuns\)/g,
    raw: /update (?:sequence_runs|\$\{sequenceRuns\})(?: \w+)? set\b(?:(?!\bwhere\b)[^`;])*?\bstatus\s*=/g,
    guard: /runMayBecome\(|(eq|inArray)\(sequenceRuns\.status|status\}? in \$\{|status\}? = '/,
    inWhere: true,
  },
  {
    table: "sequence_step_runs",
    drizzle: /\.update\(sequenceStepRuns\)/g,
    raw: /update (?:sequence_step_runs|\$\{sequenceStepRuns\})(?: \w+)? set\b(?:(?!\bwhere\b)[^`;])*?\bstatus\s*=/g,
    guard: /stepMayBecome\(|heldStep\(|(eq|inArray)\(sequenceStepRuns\.status|status\}? in \$\{|status\}? = '/,
    inWhere: true,
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
            const where = statement.search(/\.where\(|\bwhere\b/);
            const guarded = rule.guard.test(rule.inWhere ? (where < 0 ? "" : statement.slice(where)) : statement);
            if (setsStatus && !guarded) {
              unguarded.push(`${path.relative(ROOT, file)}:${source.slice(0, match.index).split("\n").length}`);
            }
          }
        }
      }
      expect(unguarded).toEqual([]);
    });
  }
});
