import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";

/**
 * Status columns with a transition table in a domain module. Every statement that sets one of them names the source
 * statuses it moves from, so a late or concurrent writer changes nothing. A Drizzle update needs a guard helper or an
 * `eq`/`inArray` on the status column in the same statement; a raw SQL update needs `status in` or `status =`. A rule
 * with a `target` reads the guard from the update's own WHERE clause on the written row, so neither the status the SET
 * writes nor a status filter on another table or in a subquery counts, and its raw pattern also finds a SET that writes
 * `status` after other columns (`set due_at = ..., status = ...`).
 */
interface Rule {
  table: string;
  drizzle: RegExp;
  raw: RegExp;
  guard: RegExp;
  /**
   * The guard must filter the row the statement writes: a helper of `helpers`, an `eq`/`inArray`/`ne`/`notInArray` on
   * `<binding>.status`, or in raw SQL the status of the updated alias (bare `status` without one). It must sit in the
   * WHERE clause of the update itself, outside any subquery.
   */
  target?: { binding: string; helpers: string[] };
}

const GUARDED: Rule[] = [
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
    raw: /update (?:sequence_runs|\$\{sequenceRuns\})(?: (\w+))? set\b(?:(?!\bwhere\b)[^`;])*?\bstatus\s*=/g,
    guard: /runMayBecome\(/,
    target: { binding: "sequenceRuns", helpers: ["runMayBecome"] },
  },
  {
    table: "sequence_step_runs",
    drizzle: /\.update\(sequenceStepRuns\)/g,
    raw: /update (?:sequence_step_runs|\$\{sequenceStepRuns\})(?: (\w+))? set\b(?:(?!\bwhere\b)[^`;])*?\bstatus\s*=/g,
    guard: /stepMayBecome\(/,
    target: { binding: "sequenceStepRuns", helpers: ["stepMayBecome", "heldStep"] },
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

/** `text` without its subqueries: a raw `(select ...)` and a Drizzle `x.select(...)` chain up to the end of its argument. */
function withoutSubqueries(text: string): string {
  for (;;) {
    const raw = /\(\s*select\b/i.exec(text);
    const built = /\b\w+\s*\.select\(/.exec(text);
    const m = raw && (!built || raw.index < built.index) ? raw : built;
    if (!m) return text;
    let depth = 0;
    let end = text.length;
    for (let i = m.index; i < text.length; i++) {
      const c = text[i];
      if (c === "(") depth++;
      else if (m === raw && c === ")" && --depth === 0) {
        end = i + 1;
        break;
      } else if (m === built && depth === 0 && (c === ")" || c === "," || c === "}")) {
        end = i;
        break;
      } else if (m === built && c === ")") depth--;
    }
    text = text.slice(0, m.index) + text.slice(end);
  }
}

/** Whether the update `statement` filters the row it writes on its status. `alias` is the raw update's table alias. */
function guardsTarget(target: NonNullable<Rule["target"]>, statement: string, raw: boolean, alias: string | undefined): boolean {
  const where = statement.search(raw ? /\bwhere\b/ : /\.where\(/);
  if (where < 0) return false;
  const clause = withoutSubqueries(statement.slice(where));
  const helpers = target.helpers.map((h) => `${h}\\(`).join("|");
  if (!raw) return new RegExp(`${helpers}|\\b(?:eq|inArray|ne|notInArray)\\(${target.binding}\\.status\\b`).test(clause);
  const column = alias ? `(?:\\$\\{${alias}\\.status\\}|\\b${alias}\\.status\\b)` : `(?:\\$\\{${target.binding}\\.status\\}|(?<![.\\w}"])status\\b)`;
  return new RegExp(`\\$\\{(?:${helpers})|${column}\\s*(?:in\\b|=|<>)`).test(clause);
}

/** Line numbers of the statements in `source` that write the rule's status without a guard. */
export function unguardedWrites(rule: Rule, source: string): number[] {
  const lines: number[] = [];
  for (const pattern of [rule.drizzle, rule.raw]) {
    for (const match of source.matchAll(pattern)) {
      const statement = statementAt(source, match.index);
      const raw = pattern === rule.raw;
      const setsStatus = raw || /\.set\(\{[^}]*\bstatus:/.test(statement);
      const guarded = rule.target ? guardsTarget(rule.target, statement, raw, raw ? match[1] : undefined) : rule.guard.test(statement);
      if (setsStatus && !guarded) lines.push(source.slice(0, match.index).split("\n").length);
    }
  }
  return lines;
}

describe("status guards", () => {
  for (const rule of GUARDED) {
    it(`every write of ${rule.table}.status names the statuses it moves from`, () => {
      const unguarded: string[] = [];
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const line of unguardedWrites(rule, source)) unguarded.push(`${path.relative(ROOT, file)}:${line}`);
      }
      expect(unguarded).toEqual([]);
    });
  }
});

describe("status guard scan catches a guard on the wrong row", () => {
  const steps = GUARDED.find((r) => r.table === "sequence_step_runs")!;
  const lines = (text: string) => unguardedWrites({ ...steps, drizzle: new RegExp(steps.drizzle), raw: new RegExp(steps.raw) }, text);

  it("a raw update guarded only on another alias, or on its own alias", () => {
    expect(lines("await db.execute(sql`with pick as (select id from x) update ${sequenceStepRuns} u set status = 'drafting' from pick where ${u.id} = pick.id and ${r.status} = 'active'`);")).toEqual([1]);
    expect(lines("await db.execute(sql`with pick as (select id from x) update ${sequenceStepRuns} u set status = 'drafting' from pick where ${u.id} = pick.id and ${u.status} in ${sqlValues(CLAIMABLE)}`);")).toEqual([]);
    expect(lines("await db.execute(sql`update sequence_step_runs set status = 'failed' where id in (select id from sequence_step_runs where status = 'drafting')`);")).toEqual([1]);
    expect(lines("await db.execute(sql`update sequence_step_runs set status = 'failed' where status = 'drafting'`);")).toEqual([]);
  });

  it("a Drizzle update guarded only inside a subquery, or on the written row", () => {
    expect(
      lines("await tx.update(sequenceStepRuns).set({ status: \"cancelled\" }).where(inArray(sequenceStepRuns.id, tx.select({ id: sequenceStepRuns.id }).from(sequenceStepRuns).where(eq(sequenceStepRuns.status, \"scheduled\"))));"),
    ).toEqual([1]);
    expect(lines("await tx.update(sequenceStepRuns).set({ status: \"cancelled\" }).where(and(eq(sequenceStepRuns.id, id), stepMayBecome(\"cancelled\")));")).toEqual([]);
    expect(lines("await tx.update(sequenceStepRuns).set({ status: \"cancelled\" }).where(and(eq(sequenceStepRuns.runId, id), eq(sequenceRuns.status, \"active\")));")).toEqual([1]);
  });
});
