import type postgres from "postgres";

/**
 * Tenant-scope audit of the public schema (DB-012, PLAT-018). `auditSchema` returns one message per problem, so the
 * integration test can assert an empty list and also feed it a scratch table that breaks a rule.
 *
 * A table is scoped when it has `organization_id uuid not null`, a foreign key to `organizations (id)` and an index that
 * contains the column. A table that cannot meet a rule must be named below with a reason. The lists only shrink: an
 * entry that is no longer needed fails the audit, so nobody forgets to remove it.
 */

/** Tables with no `organization_id` column at all. */
export const NO_SCOPE: Record<string, string> = {
  organizations: "The tenant root.",
  users: "Better Auth identity. A user can belong to several organizations through `members`.",
  accounts: "Better Auth sign-in methods, owned by a user.",
  sessions: "Better Auth sessions, owned by a user.",
  verifications: "Better Auth one-time tokens (email verification, password reset), keyed by identifier.",
  integration_credentials: "Encrypted secrets keyed by `integration_accounts`, which carries the organization. Cascades from it.",
};

/** Tables whose `organization_id` is nullable and has no foreign key, by design. */
export const NULLABLE_SCOPE: Record<string, string> = {
  inbound_events: "Webhook payloads are stored before the organization is known, and the retention job (not an organization delete) removes them.",
  job_runs: "Slot claims for platform jobs run without an organization. Per-organization jobs set the column. The retention job prunes the rows.",
};

/** Why a table may lack an index that contains `organization_id`. */
export const INDEX_DEBT_REASON =
  "Reached through an indexed parent key. Only an organization delete would scan it, and organization deletion is disabled (disableOrganizationDeletion in auth.ts).";

/**
 * Scoped tables with no index that contains `organization_id`. T8b-index-debt triaged the 22 entries of T8: grid_jobs, sends,
 * ai_jobs and contact_policies got an index (migration 0019) and linkedin_search_batches and linkedin_search_queries got one
 * (0021) because an organization-filtered query reads them. The rest stay
 * here. Frozen: add no entry. The audit test pins this exact list, so it can only shrink.
 */
export const INDEX_DEBT: Record<string, string> = Object.fromEntries(
  [
    "campaign_senders",
    "draft_knowledge_citations",
    "events",
    "grid_columns",
    "grid_provider_credentials",
    "grid_user_views",
    "linkedin_connections",
    "linkedin_enrollment_details",
    "linkedin_search_results",
    "notes",
    "pipeline_settings",
    "record_sequence_overrides",
    "send_attempts",
    "sequence_step_runs",
    "subcategory_sequence_assignments",
  ].map((table) => [table, INDEX_DEBT_REASON]),
);

interface TableFacts {
  table: string;
  has_org: boolean;
  org_nullable: boolean;
  org_fk: boolean;
  org_indexed: boolean;
}

export async function tableFacts(sql: postgres.Sql): Promise<TableFacts[]> {
  const rows = await sql<TableFacts[]>`
    with t as (
      select c.oid, c.relname,
        (select a.attnum from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped) as org_attnum
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
    )
    select t.relname as "table",
      t.org_attnum is not null as has_org,
      coalesce((select not a.attnotnull from pg_attribute a where a.attrelid = t.oid and a.attnum = t.org_attnum), false) as org_nullable,
      exists (
        select 1 from pg_constraint k
        where k.conrelid = t.oid and k.contype = 'f' and k.conkey = array[t.org_attnum]::smallint[] and k.confrelid = 'public.organizations'::regclass
      ) as org_fk,
      exists (select 1 from pg_index i where i.indrelid = t.oid and t.org_attnum = any (i.indkey::smallint[])) as org_indexed
    from t order by t.relname`;
  return [...rows];
}

export async function auditSchema(sql: postgres.Sql): Promise<string[]> {
  const facts = await tableFacts(sql);
  const byName = new Map(facts.map((f) => [f.table, f]));
  const problems: string[] = [];

  for (const [name, list] of [["NO_SCOPE", NO_SCOPE], ["NULLABLE_SCOPE", NULLABLE_SCOPE], ["INDEX_DEBT", INDEX_DEBT]] as const) {
    for (const table of Object.keys(list)) {
      if (!byName.has(table)) problems.push(`${name} names ${table}, which is not a public table. Remove the entry.`);
    }
  }

  for (const f of facts) {
    const { table } = f;
    if (table in NO_SCOPE) {
      if (f.has_org) problems.push(`${table} has organization_id but is in NO_SCOPE. Remove the entry.`);
      continue;
    }
    if (!f.has_org) {
      problems.push(`${table} has no organization_id column. Add organization_id uuid not null references organizations, or list the table in NO_SCOPE with a reason.`);
      continue;
    }
    if (table in NULLABLE_SCOPE) {
      if (!f.org_nullable) problems.push(`${table} is in NULLABLE_SCOPE but organization_id is not null. Remove the entry.`);
    } else {
      if (f.org_nullable) problems.push(`${table}.organization_id is nullable. Make it not null, or list the table in NULLABLE_SCOPE with a reason.`);
      if (!f.org_fk) problems.push(`${table}.organization_id has no foreign key to organizations (id).`);
    }
    if (table in INDEX_DEBT) {
      if (f.org_indexed) problems.push(`${table} now has an index on organization_id but is in INDEX_DEBT. Remove the entry.`);
    } else if (!f.org_indexed) {
      problems.push(`${table} has no index that contains organization_id. Add one.`);
    }
  }
  return problems;
}
