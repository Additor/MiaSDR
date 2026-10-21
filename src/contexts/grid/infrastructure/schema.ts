import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "@/contexts/identity/infrastructure/schema";
import { createdAt, orgId, pk, tstz, updatedAt } from "@/platform/db/columns";

/**
 * Grid: Clay-style enrichment tables. Folder > workbook > table > columns and rows.
 * Cells live in `grid_rows.cells` (jsonb keyed by column key) with per-cell run
 * state in `cell_meta`. Every table carries organization_id, including the
 * children a worker reads without their parent.
 *
 * Provider secrets live only in `grid_provider_credentials`, encrypted with the
 * integrations AES-256-GCM envelope.
 */

const inList = (column: unknown, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "))})`;

export const GRID_COLUMN_TYPES = [
  "text", "number", "currency", "boolean", "date", "url", "email", "image", "select", "multiselect", "json",
  "enrichment", "integration_output", "ai_output", "http", "ai", "functions", "message", "waterfall", "formula", "merge",
] as const;
export const GRID_JOB_STATUSES = ["queued", "running", "waiting", "succeeded", "failed"] as const;
export const GRID_CELL_OUTCOMES = ["hit", "miss", "error", "failed", "skipped", "cancelled"] as const;

/** Bumped on every row write so clients can poll `version > cursor`. */
export const gridRowVersionSeq = pgSequence("grid_row_version_seq");

export const gridFolders = pgTable(
  "grid_folders",
  {
    id: pk(),
    organizationId: orgId(),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("grid_folders_id_org_uq").on(t.id, t.organizationId),
    foreignKey({ columns: [t.parentId, t.organizationId], foreignColumns: [t.id, t.organizationId] }).onDelete("restrict"),
    check("grid_folders_name_ck", sql`length(btrim(${t.name})) > 0`),
    check("grid_folders_parent_ck", sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
    index("grid_folders_org_parent_idx").on(t.organizationId, t.parentId),
  ],
);

export const gridWorkbooks = pgTable(
  "grid_workbooks",
  {
    id: pk(),
    organizationId: orgId(),
    folderId: uuid("folder_id"),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("grid_workbooks_id_org_uq").on(t.id, t.organizationId),
    foreignKey({ columns: [t.folderId, t.organizationId], foreignColumns: [gridFolders.id, gridFolders.organizationId] }).onDelete("restrict"),
    check("grid_workbooks_name_ck", sql`length(btrim(${t.name})) > 0`),
    index("grid_workbooks_org_folder_idx").on(t.organizationId, t.folderId),
  ],
);

export const gridTables = pgTable(
  "grid_tables",
  {
    id: pk(),
    organizationId: orgId(),
    workbookId: uuid("workbook_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    autoRun: boolean("auto_run").notNull().default(true),
    position: doublePrecision("position").notNull(),
    /** Saved filters, sorts and hidden columns. */
    view: jsonb("view").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("grid_tables_id_org_uq").on(t.id, t.organizationId),
    foreignKey({ columns: [t.workbookId, t.organizationId], foreignColumns: [gridWorkbooks.id, gridWorkbooks.organizationId] }).onDelete("cascade"),
    check("grid_tables_name_ck", sql`length(btrim(${t.name})) > 0`),
    index("grid_tables_workbook_pos_idx").on(t.workbookId, t.position),
  ],
);

/** Per-user sort, filter and hidden columns. `grid_tables.view` stays the shared default. */
export const gridUserViews = pgTable(
  "grid_user_views",
  {
    id: pk(),
    organizationId: orgId(),
    tableId: uuid("table_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    view: jsonb("view").$type<Record<string, unknown>>().default({}).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tableId, t.organizationId], foreignColumns: [gridTables.id, gridTables.organizationId] }).onDelete("cascade"),
    unique("grid_user_views_table_user_uq").on(t.tableId, t.userId),
  ],
);

export const gridColumns = pgTable(
  "grid_columns",
  {
    id: pk(),
    organizationId: orgId(),
    tableId: uuid("table_id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    /** Column keys this column reads, the edges of the run DAG. */
    dependsOn: text("depends_on").array().default(sql`'{}'::text[]`).notNull(),
    position: doublePrecision("position").notNull(),
    autoRun: boolean("auto_run").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tableId, t.organizationId], foreignColumns: [gridTables.id, gridTables.organizationId] }).onDelete("cascade"),
    unique("grid_columns_table_key_uq").on(t.tableId, t.key),
    check("grid_columns_type_ck", inList(t.type, GRID_COLUMN_TYPES)),
    check("grid_columns_key_ck", sql`${t.key} <> '' and length(btrim(${t.name})) > 0`),
    index("grid_columns_table_pos_idx").on(t.tableId, t.position),
  ],
);

export const gridRows = pgTable(
  "grid_rows",
  {
    id: pk(),
    organizationId: orgId(),
    tableId: uuid("table_id").notNull(),
    position: doublePrecision("position").notNull(),
    cells: jsonb("cells").$type<Record<string, unknown>>().default({}).notNull(),
    cellMeta: jsonb("cell_meta").$type<Record<string, unknown>>().default({}).notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(sql`nextval('grid_row_version_seq')`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tableId, t.organizationId], foreignColumns: [gridTables.id, gridTables.organizationId] }).onDelete("cascade"),
    unique("grid_rows_id_org_uq").on(t.id, t.organizationId),
    check("grid_rows_cells_ck", sql`jsonb_typeof(${t.cells}) = 'object' and jsonb_typeof(${t.cellMeta}) = 'object'`),
    index("grid_rows_table_pos_idx").on(t.tableId, t.position),
    index("grid_rows_table_version_idx").on(t.tableId, t.version),
  ],
);

/** Cost and outcome ledger, one row per cell execution. */
export const gridCellRuns = pgTable(
  "grid_cell_runs",
  {
    id: pk(),
    organizationId: orgId(),
    tableId: uuid("table_id").notNull(),
    rowId: uuid("row_id").notNull(),
    columnKey: text("column_key").notNull(),
    provider: text("provider"),
    outcome: text("outcome").notNull(),
    costCents: numeric("cost_cents", { precision: 12, scale: 6 }).notNull().default("0"),
    /** Vendor credits the call used; null for a provider without credits and for rows written before credits were kept. */
    credits: numeric("credits", { precision: 12, scale: 4 }),
    latencyMs: integer("latency_ms"),
    request: jsonb("request").$type<unknown>(),
    response: jsonb("response").$type<unknown>(),
    /** sha256 of the provider, action and folded inputs, on an answer later cells may reuse. */
    lookupKey: text("lookup_key"),
    /** The primary value and outputs a reuse gets. Gone with the table, like the rest of the row. */
    answer: jsonb("answer").$type<unknown>(),
    /** True when the answer came from an earlier row instead of the vendor; it is not a call for the rate limit. */
    reused: boolean("reused").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tableId, t.organizationId], foreignColumns: [gridTables.id, gridTables.organizationId] }).onDelete("cascade"),
    foreignKey({ columns: [t.rowId, t.organizationId], foreignColumns: [gridRows.id, gridRows.organizationId] }).onDelete("cascade"),
    check("grid_cell_runs_outcome_ck", inList(t.outcome, GRID_CELL_OUTCOMES)),
    check("grid_cell_runs_cost_ck", sql`${t.costCents} >= 0 and (${t.latencyMs} is null or ${t.latencyMs} >= 0)`),
    check("grid_cell_runs_credits_ck", sql`${t.credits} is null or ${t.credits} >= 0`),
    index("grid_cell_runs_cell_idx").on(t.rowId, t.columnKey),
    index("grid_cell_runs_table_created_idx").on(t.tableId, t.createdAt),
    index("grid_cell_runs_lookup_idx").on(t.organizationId, t.lookupKey, t.createdAt).where(sql`${t.lookupKey} is not null`),
  ],
);

/** Durable cell work queue. Workers claim with FOR UPDATE SKIP LOCKED. One job per cell. */
export const gridJobs = pgTable(
  "grid_jobs",
  {
    id: pk(),
    organizationId: orgId(),
    tableId: uuid("table_id").notNull(),
    rowId: uuid("row_id").notNull(),
    columnKey: text("column_key").notNull(),
    status: text("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: tstz("run_after").defaultNow().notNull(),
    lockedAt: tstz("locked_at"),
    error: text("error"),
    /** Async provider polling state while `waiting`. */
    providerState: jsonb("provider_state").$type<unknown>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tableId, t.organizationId], foreignColumns: [gridTables.id, gridTables.organizationId] }).onDelete("cascade"),
    foreignKey({ columns: [t.rowId, t.organizationId], foreignColumns: [gridRows.id, gridRows.organizationId] }).onDelete("cascade"),
    unique("grid_jobs_cell_uq").on(t.rowId, t.columnKey),
    check("grid_jobs_status_ck", inList(t.status, GRID_JOB_STATUSES)),
    check("grid_jobs_attempts_ck", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1`),
    check("grid_jobs_lock_ck", sql`${t.status} <> 'running' or ${t.lockedAt} is not null`),
    index("grid_jobs_claim_idx").on(t.status, t.runAfter, t.priority),
    index("grid_jobs_table_status_idx").on(t.tableId, t.status),
    // pendingIn() counts live jobs per organization before every run and cascade (enrichment-run-store.ts). Migration 0019.
    index("grid_jobs_org_status_idx").on(t.organizationId, t.status),
  ],
);

/** Enrichment provider definitions (HTTP endpoints, price, rate limit) per organization. */
export const gridProviders = pgTable(
  "grid_providers",
  {
    id: pk(),
    organizationId: orgId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url"),
    defaultCostCents: numeric("default_cost_cents", { precision: 12, scale: 6 }).notNull().default("0"),
    rateLimitPerMin: integer("rate_limit_per_min"),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("grid_providers_org_key_uq").on(t.organizationId, t.key),
    unique("grid_providers_id_org_uq").on(t.id, t.organizationId),
    check("grid_providers_key_ck", sql`${t.key} ~ '^[a-z][a-z0-9_-]*$' and length(btrim(${t.name})) > 0`),
    check("grid_providers_cost_ck", sql`${t.defaultCostCents} >= 0 and (${t.rateLimitPerMin} is null or ${t.rateLimitPerMin} > 0)`),
  ],
);

/** One AES-256-GCM envelope (`v1:<iv>:<tag>:<ciphertext>`) per provider. Never plaintext. */
export const gridProviderCredentials = pgTable(
  "grid_provider_credentials",
  {
    providerId: uuid("provider_id").primaryKey(),
    organizationId: orgId(),
    encryptedPayload: text("encrypted_payload").notNull(),
    encryptionVersion: text("encryption_version").notNull().default("v1"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.providerId, t.organizationId], foreignColumns: [gridProviders.id, gridProviders.organizationId] }).onDelete("cascade"),
    check("grid_provider_credentials_envelope_ck", sql`${t.encryptedPayload} like ${t.encryptionVersion} || ':%'`),
  ],
);
