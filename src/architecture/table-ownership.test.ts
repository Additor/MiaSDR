import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layerOf, sourceFiles } from "@/test-support/context-layers";

/**
 * Table ownership. Each table belongs to the context whose `infrastructure/schema.ts` declares it, and only that
 * context writes it. A context may read the tables of lower layers in a join; it reads a higher layer's tables only
 * through that context's read model. The two lists below hold what the code did when the rule arrived. They may only
 * shrink: an entry that no longer matches fails the suite, so remove it when you fix the code behind it.
 */

/** Source files that write a table another owner declares, with those tables. Shrink only. */
const FOREIGN_WRITES: Record<string, string[]> = {
  "src/contexts/conversations/infrastructure/drizzle-conversation-store.ts": ["people"],
  "src/contexts/conversations/infrastructure/drizzle-reply-handling-store.ts": ["campaignEnrollments"],
  "src/contexts/conversations/infrastructure/drizzle-linkedin-conversation-store.ts": ["people"],
  "src/contexts/conversations/infrastructure/drizzle-linkedin-reply-store.ts": ["linkedinAccounts"],
  "src/contexts/people/infrastructure/drizzle-lead-repository.ts": ["campaignEnrollments", "contactPolicies", "suppression_list"],
  "src/contexts/outreach/infrastructure/drizzle-channel-settings-store.ts": ["channelSettings", "organizations"],
  "src/contexts/outreach/infrastructure/drizzle-enrollment-restore.ts": ["events"],
  "src/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-account-store.ts": ["integrationAccounts", "integrationCredentials"],
  "src/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-store.ts": ["people"],
  "src/contexts/outreach/email/infrastructure/drizzle-test-send-store.ts": ["auditLog"],
  "src/contexts/tenancy/infrastructure/drizzle-member-store.ts": ["sessions"],
  "src/contexts/tenancy/infrastructure/drizzle-setup-store.ts": ["accounts", "users"],
  "src/platform/db/audit.ts": ["auditLog"],
};

/** Source files that import a higher layer's tables from a schema module, with those tables. `platform` sits below every context. Shrink only. */
const UPWARD_READS: Record<string, string[]> = {
  "src/contexts/identity/infrastructure/session.ts": ["members", "organizations"],
  "src/contexts/identity/infrastructure/signup-facts.ts": ["invitations", "members", "organizations"],
  "src/contexts/people/infrastructure/drizzle-lead-repository.ts": ["campaignEnrollments", "campaigns", "contactPolicies", "conversations", "events", "records", "sends", "suppressionList"],
  "src/contexts/people/infrastructure/people-directory.ts": ["contactPolicies", "suppressionList"],
  "src/contexts/people/infrastructure/queries.ts": ["campaignEnrollments", "campaigns", "contactPolicies", "conversations", "messages", "records"],
  "src/contexts/outreach/infrastructure/drizzle-enrollment-restore.ts": ["events"],
  "src/contexts/outreach/infrastructure/drizzle-lead-statuses.ts": ["conversations", "messages", "records"],
  "src/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-account-store.ts": ["drafts", "sendAttempts"],
  "src/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-campaign-store.ts": ["conversations"],
  "src/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-store.ts": ["contactPolicies"],
  "src/contexts/outreach/infrastructure/drizzle-outreach-store.ts": ["contactPolicies"],
  "src/contexts/outreach/linkedin/infrastructure/drizzle-personal-thread-store.ts": ["conversations", "messages", "records"],
  "src/contexts/outreach/infrastructure/drizzle-reachability.ts": ["contactPolicies"],
  "src/contexts/outreach/email/infrastructure/drizzle-test-send-store.ts": ["contactPolicies"],
  "src/contexts/outreach/infrastructure/inbox-thread-lookup.ts": ["conversations", "records"],
  "src/contexts/tenancy/infrastructure/drizzle-onboarding-store.ts": ["campaigns", "drafts", "linkedinAccounts", "mailboxes", "people"],
  "src/platform/db/audit.ts": ["auditLog"],
  "src/platform/db/columns.ts": ["organizations"],
  "src/platform/db/conversation-visibility.ts": ["conversations"],
  "src/platform/db/person-locks.ts": ["records"],
  "src/platform/jobs/rollover.ts": ["channelSettings", "organizations"],
};

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

/** The schema files of each owner, under src. A table belongs to the owner whose file declares it; `platform` owns the job runtime's tables. */
const SCHEMA_FILES: Record<string, string[]> = {
  platform: ["platform/jobs/schema.ts"],
  identity: ["contexts/identity/infrastructure/schema.ts"],
  tenancy: ["contexts/tenancy/infrastructure/schema.ts"],
  integrations: ["contexts/integrations/infrastructure/schema.ts"],
  people: ["contexts/people/infrastructure/schema.ts"],
  outreach: ["contexts/outreach/infrastructure/schema.ts"],
  conversations: ["contexts/conversations/infrastructure/schema.ts", "contexts/conversations/after-reply/infrastructure/sequences-schema.ts"],
  grid: ["contexts/grid/infrastructure/schema.ts"],
  deals: ["contexts/deals/infrastructure/schema.ts"],
};

/** The owner a source file writes as: its context, or `platform`, which sits below every context. */
const ownerOf = (file: string) => {
  const [tier, context] = path.relative(SRC, file).split(path.sep);
  return tier === "contexts" ? context : tier;
};

/** Table owner by Drizzle binding (`people`) and by SQL name (`people`, `campaign_enrollments`). */
function owners(): { byBinding: Map<string, string>; bySqlName: Map<string, string> } {
  const byBinding = new Map<string, string>();
  const bySqlName = new Map<string, string>();
  for (const [context, files] of Object.entries(SCHEMA_FILES)) {
    for (const file of files) {
      for (const m of readFileSync(path.join(SRC, file), "utf8").matchAll(/export const (\w+) = pgTable\(\s*"(\w+)"/g)) {
        byBinding.set(m[1], context);
        bySqlName.set(m[2], context);
      }
    }
  }
  return { byBinding, bySqlName };
}

/** Tables of other contexts that `source` inserts into, updates or deletes from, by Drizzle call or raw SQL. */
export function foreignWrites(own: string, source: string, table: ReturnType<typeof owners>): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/\.(?:insert|update|delete)\((\w+)\)/g)) {
    const owner = table.byBinding.get(m[1]);
    if (owner && owner !== own) found.add(m[1]);
  }
  for (const m of source.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+"?(\w+)"?/gi)) {
    const owner = table.bySqlName.get(m[1]);
    if (owner && owner !== own) found.add(m[1]);
  }
  return [...found].sort();
}

/** Tables of higher layers that `source` imports from any schema module: the barrel, a relative `./schema`, or a context's schema. */
export function upwardReads(own: string, source: string, table: ReturnType<typeof owners>): string[] {
  const lists = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["'][^"']*schema["']/g)].map((m) => m[1]);
  const names = lists.flatMap((list) => list.split(",")).map((n) => n.trim().replace(/^type\s+/, "").split(" as ")[0]).filter(Boolean);
  return [...new Set(names.filter((n) => {
    const owner = table.byBinding.get(n);
    return owner !== undefined && owner !== own && owner !== "platform" && layerOf(owner) > layerOf(own);
  }))].sort();
}

/** `{ file: tables }` over every context and platform source file, files with no finding left out. */
function scan(find: (own: string, source: string, table: ReturnType<typeof owners>) => string[]): Record<string, string[]> {
  const table = owners();
  const out: Record<string, string[]> = {};
  for (const file of [...sourceFiles(path.join(SRC, "contexts")), ...sourceFiles(path.join(SRC, "platform"))]) {
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
    expect(scan(foreignWrites)).toEqual(FOREIGN_WRITES);
  });

  it("reads a higher layer's tables only where the shrink-only list allows it", () => {
    expect(scan(upwardReads)).toEqual(UPWARD_READS);
  });

  it("catches a Drizzle write, a raw SQL write and an upward import", () => {
    const table = owners();
    const source = [
      'import { conversations, people, mailboxes } from "@/platform/db/schema";',
      "import { records } from './schema';",
      "await tx.update(people).set({ name });",
      "await tx.execute(sql`delete from campaign_enrollments where id = ${id}`);",
    ].join("\n");
    expect(foreignWrites("people", source, table)).toEqual(["campaign_enrollments"]);
    expect(foreignWrites("outreach", source, table)).toEqual(["people"]);
    expect(upwardReads("people", source, table)).toEqual(["conversations", "mailboxes", "records"]);
  });
});
