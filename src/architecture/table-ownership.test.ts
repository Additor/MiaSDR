import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layerOf, sourceFiles } from "./context-layers";

/**
 * Table ownership. Each table belongs to the context whose `infrastructure/schema.ts` declares it, and only that
 * context writes it. A context may read the tables of lower layers in a join; it reads a higher layer's tables only
 * through that context's read model, or from `src/read-models`, which reads any context's tables and writes none. The two lists below hold what the code did when the rule arrived. They may only
 * shrink: an entry that no longer matches fails the suite, so remove it when you fix the code behind it.
 */

/**
 * Source files that write a table another owner declares, with those tables. Shrink only. `sql.raw(...)` names a write
 * whose table the scan cannot read from the text.
 */
const FOREIGN_WRITES: Record<string, string[]> = {
  // The fake provider's seed route, which answers only in a test build. Its rows stand in for what sign-up and a real LinkedIn connect write.
  "src/app/api/webhooks/dev-fakes/route.ts": ["accounts", "linkedinAccounts", "members", "users"],
  // The retention job, whose tables RETENTION_TABLES lists with reasons.
  "src/platform/jobs/prune.ts": ["sql.raw(table)"],
};

/** Tables of other owners that the retention job deletes old rows from, and why each may go. Platform holds the one schedule and budget for them. */
const RETENTION_TABLES: Record<string, string> = {
  inbound_events: "Done, skipped and failed webhook events past their window; nothing reads them once handled.",
  ai_jobs: "Succeeded AI jobs past their window; the draft or pick they wrote stays.",
  mcp_tool_calls: "The agent call log, kept for the window an operator sets.",
  mcp_agent_usage: "Daily agent counters; limits read today's row only.",
  mia_runs: "Finished Mia runs. Their input and checkpoint are already empty.",
  mia_suggestions: "Suggestions a person already decided. What they accepted lives in Brain.",
  mia_usage_daily: "Daily Mia token counters; limits read today's row only.",
  mia_messages: "Chat messages past their window. A chat keeps its newer turns.",
  mia_threads: "Chats with no message left, once their window passed.",
  sessions: "Sessions past expiry.",
  verifications: "Verification tokens past expiry.",
  oauth_refresh_tokens: "Refresh tokens past expiry.",
  oauth_client_assertions: "Replay records of assertions past expiry.",
};

/**
 * Source files that read the tables of their own layer or a higher one, by schema import or in a raw `sql` template, with those tables.
 * `platform` sits below every context. Shrink only. The scan stops at a nested template and skips `sql.raw` text.
 */
const UPWARD_READS: Record<string, string[]> = {
  "src/contexts/identity/infrastructure/session.ts": ["members", "organizations"],
  "src/contexts/identity/infrastructure/signup-facts.ts": ["invitations", "members", "organizations"],
  "src/contexts/outreach/infrastructure/drizzle-enrollment-restore.ts": ["conversations", "messages", "threads"],
  "src/contexts/outreach/linkedin/infrastructure/linkedin-account-state.ts": ["drafts", "sendAttempts"],
  "src/contexts/outreach/infrastructure/inbox-thread-lookup.ts": ["conversations", "threads"],
  "src/contexts/tenancy/infrastructure/drizzle-onboarding-store.ts": ["linkedinAccounts", "mailboxes", "people"],
  "src/platform/db/columns.ts": ["organizations"],
};

/**
 * Database views, the one way a context publishes a read to the layers below it, for a rule those layers must run inside
 * their own statements. A view reads tables the scans above cannot see, so each one names its owner and every file outside
 * the owner that reads it, and the test below fails on anything else.
 */
const PUBLISHED_VIEWS: Record<string, { owner: string; readers: string[] }> = {
  stop_review_open_messages: { owner: "conversations", readers: [] },
  stop_review_open_people: { owner: "conversations", readers: ["src/contexts/outreach/infrastructure/stop-review-gate.ts"] },
};

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

/** `src/read-models`: reads across contexts, and no writes. Every table has another owner, so any write it makes is foreign. */
const READ_MODELS = "read-models";

/** The schema files of each owner, under src. A table belongs to the owner whose file declares it; `platform` owns the job runtime's tables. */
const SCHEMA_FILES: Record<string, string[]> = {
  platform: ["platform/jobs/schema.ts"],
  identity: ["contexts/identity/infrastructure/schema.ts"],
  tenancy: ["contexts/tenancy/infrastructure/schema.ts"],
  "agent-access": ["contexts/agent-access/infrastructure/schema.ts"],
  integrations: ["contexts/integrations/infrastructure/schema.ts"],
  people: ["contexts/people/infrastructure/schema.ts"],
  outreach: ["contexts/outreach/infrastructure/schema.ts"],
  conversations: ["contexts/conversations/infrastructure/schema.ts", "contexts/conversations/after-reply/infrastructure/follow-ups-schema.ts"],
  grid: ["contexts/grid/infrastructure/schema.ts"],
  deals: ["contexts/deals/infrastructure/schema.ts"],
};

/** The owner a source file writes as: its context, `platform`, which sits below every context, or `read-models`, which owns no table. */
const ownerOf = (file: string) => {
  const [tier, context] = path.relative(SRC, file).split(path.sep);
  return tier === "contexts" ? context : tier;
};

/** Table owner by Drizzle binding (`people`) and by SQL name (`people`, `campaign_enrollments`), and the binding of each SQL name. */
function owners(): { byBinding: Map<string, string>; bySqlName: Map<string, string>; bindingOf: Map<string, string> } {
  const byBinding = new Map<string, string>();
  const bySqlName = new Map<string, string>();
  const bindingOf = new Map<string, string>();
  for (const [context, files] of Object.entries(SCHEMA_FILES)) {
    for (const file of files) {
      for (const m of readFileSync(path.join(SRC, file), "utf8").matchAll(/export const (\w+) = pgTable\(\s*"(\w+)"/g)) {
        byBinding.set(m[1], context);
        bySqlName.set(m[2], context);
        bindingOf.set(m[2], m[1]);
      }
    }
  }
  return { byBinding, bySqlName, bindingOf };
}

/** What a local name stands for when it holds a table: `const p = people`, `const p = alias(people, "p")`, `const t = a ? people : deals`. */
function tableAliases(source: string): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const m of source.matchAll(/\bconst\s+(\w+)\s*=\s*(?:alias\(\s*)?(?:[\w.!]+\s*\?\s*)?(?:\w+\.)?(\w+)(?:\s*:\s*(?:\w+\.)?(\w+))?\s*[,;)\n]/g)) {
    aliases.set(m[1], [m[2], m[3]].filter(Boolean));
  }
  return aliases;
}

/** Tables of other contexts that `source` inserts into, updates or deletes from, by Drizzle call or raw SQL. */
export function foreignWrites(own: string, source: string, table: ReturnType<typeof owners>): string[] {
  const found = new Set<string>();
  const aliases = tableAliases(source);
  const addBinding = (name: string) => {
    for (const binding of [name, ...(aliases.get(name) ?? [])]) {
      const owner = table.byBinding.get(binding);
      if (owner && owner !== own) found.add(binding);
    }
  };
  // `insert(people)`, `delete( people )`, `update(schema.people)` and `update(a ? people : deals)` alike: spaces, a namespace import and a choice do not hide a write.
  for (const m of source.matchAll(/\.(?:insert|update|delete)\(\s*(?:[\w.!]+\s*\?\s*)?(?:\w+\.)?(\w+)(?:\s*:\s*(?:\w+\.)?(\w+))?\s*\)/g)) {
    addBinding(m[1]);
    if (m[2]) addBinding(m[2]);
  }
  for (const m of source.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+"?(\w+)"?/gi)) {
    const owner = table.bySqlName.get(m[1]);
    if (owner && owner !== own) found.add(m[1]);
  }
  // A table interpolated into the statement: sql`update ${people}`.
  for (const m of source.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+\$\{\s*(?:\w+\.)?(\w+)\s*\}/gi)) addBinding(m[1]);
  // A name given to `sql.raw`: a literal counts as that table, and anything else cannot be read from the text, so it counts as a write of its own.
  for (const m of source.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+\$\{\s*sql\.raw\(\s*([^)]*?)\s*\)\s*\}/gi)) {
    const literal = m[1].match(/^["'`](\w+)["'`]$/);
    if (!literal) found.add(`sql.raw(${m[1]})`);
    else if ((table.bySqlName.get(literal[1]) ?? own) !== own) found.add(literal[1]);
  }
  return [...found].sort();
}

/**
 * Tables of the same or a higher layer that `source` reads: imported from any schema module (the barrel, a relative `./schema`, or a
 * context's schema), or named after `from` or `join` in a raw `sql` template (a `delete from` is a write, not a read).
 * Raw names count under their Drizzle binding.
 */
export function upwardReads(own: string, source: string, table: ReturnType<typeof owners>): string[] {
  // Read models sit above every context to join their tables for one screen, so any read is in reach.
  if (own === READ_MODELS) return [];
  const lists = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["'][^"']*schema["']/g)].map((m) => m[1]);
  const imported = lists.flatMap((list) => list.split(",")).map((n) => n.trim().replace(/^type\s+/, "").split(" as ")[0]).filter(Boolean);
  const raw = [...source.matchAll(/sql(?:<[^`]*?>)?`([^`]*)`/g)].flatMap((t) => [...t[1].matchAll(/(?<!delete\s+)\b(?:from|join)\s+"?(\w+)"?/gi)].map((m) => table.bindingOf.get(m[1]) ?? ""));
  const names = [...imported, ...raw];
  return [...new Set(names.filter((n) => {
    const owner = table.byBinding.get(n);
    return owner !== undefined && owner !== own && owner !== "platform" && layerOf(owner) >= layerOf(own);
  }))].sort();
}

/** `{ file: tables }` over the source files of these tiers, files with no finding left out. `app` owns no table, so any write of its own is foreign. */
function scan(find: (own: string, source: string, table: ReturnType<typeof owners>) => string[], tiers = ["contexts", "platform", READ_MODELS]): Record<string, string[]> {
  const table = owners();
  const out: Record<string, string[]> = {};
  for (const file of tiers.flatMap((tier) => sourceFiles(path.join(SRC, tier)))) {
    const own = ownerOf(file);
    const hits = find(own, readFileSync(file, "utf8"), table);
    if (hits.length > 0) out[path.relative(ROOT, file).split(path.sep).join("/")] = hits;
  }
  return out;
}

describe("table ownership", () => {
  it("finds the tables of every context", () => {
    expect(owners().byBinding.size).toBeGreaterThan(60);
  });

  it("writes another context's tables only where the shrink-only list allows it", () => {
    expect(scan(foreignWrites, ["contexts", "platform", READ_MODELS, "app"])).toEqual(FOREIGN_WRITES);
  });

  it("lists every foreign table of the retention job, with its reason", () => {
    const table = owners();
    const prune = readFileSync(path.join(SRC, "platform/jobs/prune.ts"), "utf8");
    const tables = [...prune.matchAll(/\["(\w+)", sql`/g)].map((m) => m[1].replace(/^inbound_events_\w+$/, "inbound_events"));
    expect(tables.length).toBeGreaterThan(0);
    const foreign = [...new Set(tables.filter((name) => table.bySqlName.get(name) !== "platform"))].sort();
    expect(foreign).toEqual(Object.keys(RETENTION_TABLES).sort());
  });

  it("reads the tables of its own layer or a higher one only where the shrink-only list allows it", () => {
    expect(scan(upwardReads)).toEqual(UPWARD_READS);
  });

  it("lists every database view, and reads one outside its owner only where the list allows it", () => {
    const baseline = readFileSync(path.join(ROOT, "drizzle/0000_baseline.sql"), "utf8");
    expect([...baseline.matchAll(/CREATE VIEW public\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(Object.keys(PUBLISHED_VIEWS).sort());
    const files = ["contexts", "platform", READ_MODELS, "composition", "app"].flatMap((tier) => sourceFiles(path.join(SRC, tier)));
    for (const [view, { owner, readers }] of Object.entries(PUBLISHED_VIEWS)) {
      const foreign = files.filter((file) => ownerOf(file) !== owner && readFileSync(file, "utf8").includes(view)).map((file) => path.relative(ROOT, file).split(path.sep).join("/"));
      expect(foreign, view).toEqual(readers);
    }
  });

  it("catches a Drizzle write, a raw SQL write, an upward import and a read in a typed sql template", () => {
    const table = owners();
    const source = [
      'import { threads, people, mailboxes } from "@/platform/db/schema";',
      "import { conversations } from './schema';",
      "await tx.update(people).set({ name });",
      "await tx.execute(sql`delete from campaign_enrollments where id = ${id}`);",
      "await tx.execute(sql`select 1 from drafts d join follow_up_runs r on r.id = d.run_id`);",
      "const sent = sql<boolean>`exists (select 1 from sends s where s.person_id = people.id)`;",
    ].join("\n");
    expect(foreignWrites("people", source, table)).toEqual(["campaign_enrollments"]);
    expect(foreignWrites("outreach", source, table)).toEqual(["people"]);
    expect(upwardReads("people", source, table)).toEqual(["conversations", "drafts", "followUpRuns", "mailboxes", "sends", "threads"]);
  });

  it("catches a write through an alias, a choice, an interpolated table and sql.raw", () => {
    const table = owners();
    const wrote = (line: string) => foreignWrites("outreach", line, table);
    expect(wrote("const p = people;\nawait tx.update(p).set({ name });")).toEqual(["people"]);
    expect(wrote('const p = alias(people, "p");\nawait tx.delete(p);')).toEqual(["people"]);
    expect(wrote("const t = a ? people : conversations;\nawait tx.update(t).set(row);")).toEqual(["conversations", "people"]);
    expect(wrote("await tx.update(a ? people : conversations).set(row);")).toEqual(["conversations", "people"]);
    expect(wrote("await tx.execute(sql`update ${people} set name = ${name}`);")).toEqual(["people"]);
    expect(wrote("await tx.execute(sql`delete from ${schema.conversations} where id = ${id}`);")).toEqual(["conversations"]);
    expect(wrote('await tx.execute(sql`delete from ${sql.raw("people")} where id = ${id}`);')).toEqual(["people"]);
    expect(wrote("await db.execute(sql`delete from ${sql.raw(table)} where id = ${id}`);")).toEqual(["sql.raw(table)"]);
    // A local name that holds no table, and the context's own tables, are not findings.
    expect(wrote("const key = row.id;\nseen.delete(key);\nawait tx.update(campaigns).set(row);")).toEqual([]);
  });

  it("flags a read of a table in the same layer", () => {
    const source = 'import { deals } from "@/contexts/deals/infrastructure/schema";';
    expect(upwardReads("grid", source, owners())).toEqual(["deals"]);
  });

  it("lets a read model read any table and write none", () => {
    const table = owners();
    const source = [
      'import { campaignEnrollments, messages, people } from "@/platform/db/schema";',
      "await db.select().from(people).innerJoin(campaignEnrollments, on);",
      "await db.update(people).set({ name });",
      "await tx.execute(sql`delete from messages where id = ${id}`);",
      "await db.insert(schema.campaigns).values(row);",
      "await db.delete( conversations ).where(match);",
    ].join("\n");
    expect(upwardReads(READ_MODELS, source, table)).toEqual([]);
    expect(foreignWrites(READ_MODELS, source, table)).toEqual(["campaigns", "conversations", "messages", "people"]);
  });
});
