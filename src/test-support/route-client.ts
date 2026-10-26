import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { dropOrgs } from "./db";
import { signedInUser } from "./identity-fixture";

/*
 * In-process client for the App Router route handlers.
 *
 * It calls the exported GET/POST/... functions of each `route.ts` directly, against a real migrated Postgres and
 * the real Better Auth session code. Nothing is faked on the request path except what Next supplies at runtime:
 * `headers()` from next/headers returns the cookie of the identity a call runs as, and `connection()` from
 * next/server resolves at once. The `proxy.ts` gate does not run here (see `proxyAnswer`).
 *
 * A test file wires the two Next stand-ins in with vi.mock, which only works at the top of a test file:
 *
 *   vi.mock("server-only", () => ({}));
 *   vi.mock("next/headers", async () => (await import("@/test-support/route-client")).nextHeadersStandIn());
 *   vi.mock("next/server", async (original) => (await import("@/test-support/route-client")).nextServerStandIn(await original()));
 */

export const API_ROOT = path.join(process.cwd(), "src", "app", "api");

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Every `route.ts` under src/app/api, as a posix path relative to it, found by walking the file system. */
export function scanRouteFiles(root = API_ROOT): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") found.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
}

/** `campaigns/[id]/route.ts` becomes `campaigns/[id]`. */
export const routeKey = (file: string) => file.replace(/\/?route\.ts$/, "");

/** Dynamic segments of a route key, in order: `a/[id]/b/[sendId]` gives `["id", "sendId"]`. */
export const paramNames = (key: string) => [...key.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map((m) => m[1]);

export type RouteHandler = (request: Request, context: { params: Promise<Record<string, string>> }) => Response | Promise<Response>;

/** The handlers a route module exports. */
export async function loadRoute(file: string): Promise<Partial<Record<HttpMethod, RouteHandler>>> {
  const mod = (await import(/* @vite-ignore */ path.join(API_ROOT, file))) as Record<string, unknown>;
  const out: Partial<Record<HttpMethod, RouteHandler>> = {};
  for (const method of HTTP_METHODS) if (typeof mod[method] === "function") out[method] = mod[method] as RouteHandler;
  return out;
}

/** The HTTP methods a route file declares, read from its source. */
export function declaredMethods(file: string): HttpMethod[] {
  const source = readFileSync(path.join(API_ROOT, file), "utf8");
  return HTTP_METHODS.filter((m) => new RegExp(`export (?:async )?(?:function ${m}\\b|const ${m}\\b)`).test(source));
}

/**
 * Whether a handler reads the request body, found by reading the route source: from the handler's declaration to
 * the next exported handler. Helper functions that read the body (`readJsonObject` and friends) count.
 */
export function handlerReadsBody(file: string, method: HttpMethod): boolean {
  const source = readFileSync(path.join(API_ROOT, file), "utf8");
  const declaration = new RegExp(`export (?:async )?(?:function ${method}\\b|const ${method}\\b)`);
  const start = source.search(declaration);
  if (start < 0) return false;
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport (?:async )?(?:function|const) (?:GET|POST|PUT|PATCH|DELETE)\b/);
  const chunk = next < 0 ? rest : rest.slice(0, next);
  return /\.(?:json|text|formData|arrayBuffer)\(\)|readJsonObject|readOptionalJsonObject|readFormLimited|readBodyLimited/.test(chunk);
}

// ---- Next runtime stand-ins -------------------------------------------------------------------------------------

let currentCookie = "";

/** Module replacement for `next/headers`: the request headers carry the cookie of the identity under test. */
export function nextHeadersStandIn() {
  return {
    headers: async () => new Headers(currentCookie ? { cookie: currentCookie } : {}),
    cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
  };
}

/** Module replacement for `next/server`: `connection()` is a no-op outside a request. */
export function nextServerStandIn<T extends object>(original: T) {
  return { ...original, connection: async () => undefined };
}

// ---- Calls ------------------------------------------------------------------------------------------------------

export interface CallOptions {
  /** Values for the `[param]` segments of the route key. */
  params?: Record<string, string>;
  query?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as is (use to send malformed JSON). */
  raw?: string;
  form?: FormData;
  /** The identity to run as. `null` sends no cookie. */
  as?: Identity | null;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  body: unknown;
  text: string;
  headers: Headers;
  /** Set when the handler threw instead of answering: the framework would have answered 500. */
  thrown?: unknown;
}

export interface Identity {
  name: string;
  userId: string;
  email: string;
  cookie: string;
  organizationId: string;
  role: string;
}

export function urlFor(key: string, params: Record<string, string> = {}, query: Record<string, string> = {}): string {
  const filled = key.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, (_, name: string) => encodeURIComponent(params[name] ?? "x"));
  const qs = new URLSearchParams(query).toString();
  return `http://localhost:3000/api/${filled}${qs ? `?${qs}` : ""}`;
}

export async function callRoute(file: string, method: HttpMethod, options: CallOptions = {}): Promise<CallResult> {
  const handlers = await loadRoute(file);
  const handler = handlers[method];
  if (!handler) throw new Error(`${file} does not export ${method}`);
  const key = routeKey(file);
  const headers = new Headers(options.headers);
  let body: BodyInit | undefined;
  if (options.form) body = options.form;
  else if (options.raw !== undefined) {
    body = options.raw;
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  } else if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers.set("content-type", "application/json");
  }
  currentCookie = options.as?.cookie ?? "";
  if (currentCookie) headers.set("cookie", currentCookie);
  const request = new Request(urlFor(key, options.params, options.query), { method, headers, body });
  try {
    const response = await handler(request, { params: Promise.resolve(options.params ?? {}) });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: response.status, body: parsed, text, headers: response.headers };
  } catch (thrown) {
    return { status: 500, body: null, text: String(thrown), thrown, headers: new Headers() };
  } finally {
    currentCookie = "";
  }
}

/**
 * What `src/proxy.ts` answers for a request with no session cookie. The proxy is Next middleware, so route
 * handlers called directly never see it. The matrix runs it on its own for every protected path.
 */
export async function proxyAnswer(key: string, method: HttpMethod, cookie?: string): Promise<{ status: number; passedThrough: boolean }> {
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("@/proxy");
  const request = new NextRequest(urlFor(key), { method, headers: cookie ? { cookie } : {} });
  const response = proxy(request);
  return { status: response.status, passedThrough: response.headers.get("x-middleware-next") === "1" };
}

// ---- World: two organizations, three users, real sessions -------------------------------------------------------

export interface World {
  sql: postgres.Sql;
  orgA: { id: string; slug: string };
  orgB: { id: string; slug: string };
  /** Owner of organization A. */
  admin: Identity;
  /** Plain member of organization A. */
  member: Identity;
  /** Owner of organization B. */
  other: Identity;
  /** Creates one row of a table in an organization (parents included) and returns its columns. Null when it cannot. */
  seed(table: string, organizationId: string, force?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  close(): Promise<void>;
}

/** Needs TEST_DATABASE_URL. Migrates it, creates the world, signs the three users in through Better Auth. */
export async function createWorld(databaseUrl: string): Promise<World> {
  const secret = "r".repeat(40);
  const env: Record<string, string | undefined> = {
    DATABASE_URL: databaseUrl,
    DATABASE_SSL: "disable",
    APP_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: secret,
    INTEGRATION_CREDENTIALS_KEY: secret,
    UNSUBSCRIBE_SECRET: secret,
    CRON_SECRET: "cron-secret-for-matrix",
    MAILBOX_PROVIDER: "fake",
    LINKEDIN_PROVIDER: "fake",
    AI_PROVIDER: "fake",
    GRID_PROVIDER: "fake",
    AUTH_SIGNUP: "invite-only",
    RESEND_API_KEY: undefined,
    AUTH_EMAIL_FROM: undefined,
  };
  // `close()` puts every variable back, so the next test file starts from the environment it expects.
  const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const applyEnv = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  applyEnv(env);

  const { runMigrations } = await import("@/platform/db/migrate");
  await runMigrations();

  const sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined });
  const tag = Math.random().toString(36).slice(2, 8);

  const makeOrg = async (name: string) => {
    const [row] = await sql<{ id: string; slug: string }[]>`insert into organizations (name, slug) values (${`Matrix ${name} ${tag}`}, ${`matrix-${name}-${tag}`}) returning id, slug`;
    return row;
  };
  const orgA = await makeOrg("a");
  const orgB = await makeOrg("b");

  const makeIdentity = (name: string, organizationId: string, role: string): Promise<Identity> => signedInUser(sql, name, [{ organizationId, role }], `${name}-${tag}@matrix.test`);
  const admin = await makeIdentity("admin", orgA.id, "owner");
  const member = await makeIdentity("member", orgA.id, "member");
  const other = await makeIdentity("other", orgB.id, "owner");
  // A session opens in the first organization the user joined. The member row above is the only one per user.

  const seeder = rowSeeder(sql, { [orgA.id]: admin.userId, [orgB.id]: other.userId });

  return {
    sql,
    orgA,
    orgB,
    admin,
    member,
    other,
    seed: seeder,
    async close() {
      try {
        await dropOrgs(sql, [{ organizationId: orgA.id }, { organizationId: orgB.id }]);
        await sql`delete from users where email like ${`%-${tag}@matrix.test`}`;
      } finally {
        await sql.end();
        applyEnv(savedEnv);
      }
    },
  };
}

// ---- Generic row factory ----------------------------------------------------------------------------------------

/** Column values the schema's CHECK constraints or business rules need. Keyed by table. Filled where a table cannot be seeded blind. */
/** Why the last seed of a table failed. For diagnosing a table that needs an override. */
export const seedErrors: Record<string, string> = {};

export const SEED_OVERRIDES: Record<string, Record<string, unknown>> = {
  sequence_steps: { position: 1, step_type: "reply", delay_minutes: 0 },
  ai_jobs: { kind: "classification", entity_type: "message" },
  contact_policies: { do_not_contact: false, source: null, set_at: null, cleared_at: null },
  // The message must be inbound (cross-row validator); parentForce shapes the message the foreign key walk seeds.
  reply_type_picks: { confidence: 0.5, parentForce: { messages: { direction: "inbound" } } },
  campaign_senders: { seedFrom: { mailbox_id: "mailboxes.id" } },
  notes: { seedFrom: { record_id: "records.id", person_id: "records.person_id" } },
  // enrollment_id and step_number became nullable (test sends), so the seeder no longer follows the foreign key by itself.
  sends: { step_number: 1, seedFrom: { enrollment_id: "campaign_enrollments.id" } },
  grid_provider_credentials: { encryption_version: "v1", encrypted_payload: "v1:seed" },
  // A deal's person must be a contact (trigger on `deals`), so the person the foreign key walk seeds is one.
  deals: { parentForce: { people: { lifecycle: "contact", converted_at: new Date("2026-10-16T00:00:00Z") } } },
};

type Tx = postgres.TransactionSql;

/**
 * Per-table fix-ups the generic seeder cannot derive from foreign keys. `before` adjusts the values just before the insert.
 * `after` runs in the insert's transaction: the seeder commits one table per transaction, and a deferred foreign key is
 * checked at commit (knowledge_documents.latest_version needs its version row).
 */
const ROW_HOOKS: Record<string, { before?: (sql: postgres.Sql, values: Record<string, unknown>) => Promise<void>; after?: (tx: Tx, row: Record<string, unknown>) => Promise<unknown> }> = {
  knowledge_documents: {
    after: (tx, row) =>
      tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${row.organization_id as string}, ${row.id as string}, ${row.latest_version as number}, 'seeded')`,
  },
  // The classification validator wants the message to belong to the classification's record. The foreign key walk
  // seeds an unrelated record, so point record_id at the record of the seeded message's conversation.
  // Positions are unique per organization (checked at commit), so each seeded stage goes after the last one.
  deal_stages: {
    before: async (sql, values) => {
      const [row] = await sql`select coalesce(max(position), 0) + 1 as next from deal_stages where organization_id = ${values.organization_id as string}`;
      values.position = row.next;
    },
  },
  reply_type_picks: {
    before: async (sql, values) => {
      const [row] = await sql`select c.record_id from messages m join conversations c on c.id = m.conversation_id where m.id = ${values.message_id as string}`;
      if (row) values.record_id = row.record_id;
    },
  },
};

interface ColumnInfo {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  is_generated: string;
}

interface ForeignKey {
  cols: string[];
  parent: string;
  parentCols: string[];
}

function rowSeeder(sql: postgres.Sql, usersByOrg: Record<string, string>) {
  const columnCache = new Map<string, ColumnInfo[]>();
  const fkCache = new Map<string, ForeignKey[]>();

  const columnsOf = async (table: string) => {
    if (!columnCache.has(table)) {
      columnCache.set(
        table,
        await sql<ColumnInfo[]>`select column_name, data_type, udt_name, is_nullable, column_default, is_generated from information_schema.columns where table_schema = 'public' and table_name = ${table} order by ordinal_position`,
      );
    }
    return columnCache.get(table)!;
  };
  const fksOf = async (table: string) => {
    if (!fkCache.has(table)) {
      const rows = await sql<{ cols: string[]; parent: string; parent_cols: string[] }[]>`
        select
          (select array_agg(a.attname order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols,
          cl.relname as parent,
          (select array_agg(a.attname order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as parent_cols
        from pg_constraint c join pg_class cl on cl.oid = c.confrelid
        where c.contype = 'f' and c.conrelid = ${`public.${table}`}::regclass`;
      fkCache.set(table, rows.map((r) => ({ cols: r.cols, parent: r.parent, parentCols: r.parent_cols })));
    }
    return fkCache.get(table)!;
  };

  const checkCache = new Map<string, Record<string, string>>();
  /** First allowed literal of each `col = ANY (ARRAY[...])` CHECK constraint, so enumerated text columns get a legal value. */
  const checkDefaults = async (table: string) => {
    if (!checkCache.has(table)) {
      const rows = await sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where contype = 'c' and conrelid = ${`public.${table}`}::regclass`;
      const out: Record<string, string> = {};
      for (const { def } of rows) {
        const m = def.match(/\(?"?(\w+)"?(?:::text)? = ANY \(ARRAY\[([^\]]+)\]/);
        const literal = m?.[2].match(/'([^']*)'/);
        if (m && literal) out[m[1]] = literal[1];
      }
      checkCache.set(table, out);
    }
    return checkCache.get(table)!;
  };

  const placeholder = async (col: ColumnInfo, nonce: string): Promise<unknown> => {
    switch (col.data_type) {
      case "uuid":
        return crypto.randomUUID();
      case "text":
      case "character varying":
        return `seed_${col.column_name}_${nonce}`;
      case "integer":
      case "bigint":
      case "smallint":
      case "numeric":
      case "double precision":
      case "real":
        return 1;
      case "boolean":
        return false;
      case "jsonb":
      case "json":
        return {};
      case "date":
        return "2026-01-01";
      case "timestamp with time zone":
      case "timestamp without time zone":
        return new Date();
      case "ARRAY":
        return "{}";
      case "USER-DEFINED": {
        const [label] = await sql<{ enumlabel: string }[]>`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = ${col.udt_name} order by e.enumsortorder limit 1`;
        return label?.enumlabel;
      }
      default:
        throw new Error(`no placeholder for ${col.data_type}`);
    }
  };

  const seed = async (table: string, organizationId: string, depth = 0, forced: Record<string, unknown> = {}): Promise<Record<string, unknown> | null> => {
    if (depth > 6) return null;
    const columns = await columnsOf(table);
    const fks = await fksOf(table);
    const nonce = Math.random().toString(36).slice(2, 10);
    const values: Record<string, unknown> = { ...(await checkDefaults(table)), ...SEED_OVERRIDES[table], ...forced };
    if (columns.some((c) => c.column_name === "organization_id") && !("organization_id" in values)) values.organization_id = organizationId;

    // seedFrom: { column: "table.parentColumn" } copies columns of one freshly seeded parent per table.
    const parents = new Map<string, Record<string, unknown>>();
    for (const [column, source] of Object.entries((values.seedFrom as Record<string, string> | undefined) ?? {})) {
      const [parentTable, parentColumn = "id"] = source.split(".");
      if (!parents.has(parentTable)) {
        const parentRow = await seed(parentTable, organizationId, depth + 1);
        if (!parentRow) return null;
        parents.set(parentTable, parentRow);
      }
      values[column] = parents.get(parentTable)![parentColumn];
    }
    delete values.seedFrom;
    // parentForce: { table: { column: value } } shapes the parent rows the foreign keys below create (a LinkedIn campaign for an enrollment).
    const parentForce = (values.parentForce as Record<string, Record<string, unknown>> | undefined) ?? {};
    delete values.parentForce;

    // Foreign keys that overlap (messages has one on (conversation_id, organization_id) and one on
    // (conversation_id, channel, account_ref)) must point at the same parent row. Process the widest key first
    // and let later keys reuse the row that already filled one of their columns.
    const parentRowOfColumn = new Map<string, { table: string; row: Record<string, unknown> }>();
    const orderedFks = [...fks].sort((a, b) => b.cols.length - a.cols.length || a.cols.join().localeCompare(b.cols.join()) || a.parent.localeCompare(b.parent));
    for (const fk of orderedFks) {
      const required = fk.cols.every((c) => {
        const info = columns.find((x) => x.column_name === c);
        return info?.is_nullable === "NO" && info.column_default === null;
      });
      if (!required || fk.cols.every((c) => c in values)) continue;
      const shared = fk.cols.map((c) => parentRowOfColumn.get(c)).find((p) => p?.table === fk.parent);
      if (fk.parent === "organizations") {
        for (const c of fk.cols) values[c] = organizationId;
        continue;
      }
      if (fk.parent === "users") {
        for (const c of fk.cols) values[c] = usersByOrg[organizationId];
        continue;
      }
      const parentRow = shared?.row ?? (await seed(fk.parent, organizationId, depth + 1, parentForce[fk.parent]));
      if (!parentRow) return null;
      fk.cols.forEach((c, i) => {
        if (!(c in values)) {
          values[c] = parentRow[fk.parentCols[i]];
          parentRowOfColumn.set(c, { table: fk.parent, row: parentRow });
        }
      });
    }

    for (const col of columns) {
      if (col.column_name in values || col.is_nullable === "YES" || col.column_default !== null || col.is_generated === "ALWAYS") continue;
      values[col.column_name] = await placeholder(col, nonce);
    }

    await ROW_HOOKS[table]?.before?.(sql, values);
    const names = Object.keys(values);
    try {
      const [row] = await sql.begin(async (tx) => {
        // A failed insert must not poison the caller's connection.
        const rows = await tx.unsafe(
          `insert into "${table}" (${names.map((n) => `"${n}"`).join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
          names.map((n) => values[n] as never),
        );
        await ROW_HOOKS[table]?.after?.(tx, rows[0]);
        return rows;
      });
      return row as Record<string, unknown>;
    } catch (error) {
      seedErrors[table] = String((error as Error).message);
      return null;
    }
  };

  return (table: string, organizationId: string, force?: Record<string, unknown>) => seed(table, organizationId, 0, force);
}
