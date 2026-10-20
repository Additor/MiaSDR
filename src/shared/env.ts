import { z } from "zod";

/**
 * Reduces the public URL to its origin: a trailing slash goes, a path, query
 * or fragment is an error. Better Auth compares trusted origins with the
 * request origin, and `${APP_URL}/path` links must not get a double slash.
 */
function toOrigin(value: string, ctx: z.RefinementCtx): string {
  const url = new URL(value);
  if (url.pathname.replace(/\/+$/, "") !== "" || url.search || url.hash || url.username || url.password) {
    ctx.addIssue({ code: "custom", message: "APP_URL must be an origin such as https://sdr.example.com, without a path, query or credentials" });
    return z.NEVER;
  }
  return url.origin;
}

const TRUE_WORDS = ["1", "true", "yes", "on"];
const FALSE_WORDS = ["0", "false", "no", "off"];

/**
 * Reads a boolean environment value. `1/true/yes/on` and `0/false/no/off` work in any case with surrounding spaces.
 * Unset or empty gives the default. Anything else throws, so a typo cannot leave a switch in the wrong state.
 */
export function flag(value: string | undefined, defaultValue: boolean, name?: string): boolean {
  const word = (value ?? "").trim().toLowerCase();
  if (word === "") return defaultValue;
  if (TRUE_WORDS.includes(word)) return true;
  if (FALSE_WORDS.includes(word)) return false;
  throw new Error(`${name ? `${name}: ` : ""}"${value}" is not a boolean. Use one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(", ")}.`);
}

/** Zod form of `flag()`, for the env schema. */
export const flagSchema = (defaultValue: boolean) =>
  z.string().optional().transform((value, ctx) => {
    try {
      return flag(value, defaultValue);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
      return z.NEVER;
    }
  });

export const appUrlSchema = z.string().url().transform(toOrigin);

/**
 * Validated on first use, not at import: `next build` loads every route and
 * must not need secrets.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  /** "disable" for the bundled Postgres container, otherwise TLS is required. */
  DATABASE_SSL: z.enum(["disable", "require"]).default("require"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(8),
  /** Applies pending migrations at boot (production only). Set false to run `pnpm db:migrate` yourself. Default true. */
  RUN_MIGRATIONS: flagSchema(true),
  /** Runs the job tick inside the server process. Set false when an external scheduler calls `/api/jobs/tick`. Default true. */
  EMBEDDED_SCHEDULER: flagSchema(true),
  /** Emergency brake: while true, automated sequence sends (email and LinkedIn) and test sends are held. Approved replies still send. A lenient string here: `src/shared/outbound-pause.ts` is the only parser and treats an unreadable value as paused. Default false. */
  PAUSE_OUTBOUND: z.string().optional(),
  /** Two-letter country (ISO 3166-1 alpha-2) for phone numbers written without a country code, such as `KR` for `010-...`. An organization setting overrides it. Read from the process environment at call time. */
  DEFAULT_PHONE_COUNTRY: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "must be a two-letter country code such as KR")
    .transform((value) => value.toUpperCase())
    .optional(),

  APP_URL: appUrlSchema,
  BETTER_AUTH_SECRET: z.string().min(32),
  INTEGRATION_CREDENTIALS_KEY: z.string().min(32),
  /** Old credential keys, comma separated, 32 characters or more each. Decrypt only; `pnpm credentials:rotate` moves rows to the current key. */
  INTEGRATION_CREDENTIALS_LEGACY_KEYS: z
    .string()
    .refine((v) => v.split(",").map((k) => k.trim()).filter(Boolean).every((k) => k.length >= 32), "every key must be at least 32 characters")
    .optional(),
  UNSUBSCRIBE_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(16).optional(),

  /** `fake` keeps mail in memory (demos and tests only). Without it, mailbox calls explain that Google is not connected. */
  MAILBOX_PROVIDER: z.enum(["gmail", "fake"]).optional(),
  /** `fake` keeps LinkedIn in memory (demos and tests only). Default is Unipile with credentials saved per organization. */
  LINKEDIN_PROVIDER: z.enum(["unipile", "fake"]).optional(),
  /** Extra Unipile DSN hosts besides `*.unipile.com`, comma separated (`host`, `host:port` or `*.domain`). Empty by default. */
  LINKEDIN_DSN_ALLOWED_HOSTS: z.string().optional(),
  /** `fake` answers AI calls with a keyword classifier and template drafts (demos and tests only). Default: each organization's own Anthropic key. */
  AI_PROVIDER: z.enum(["anthropic", "fake"]).optional(),
  /** Anthropic model id when an organization's integration does not set one. Default claude-sonnet-5-5. */
  AI_MODEL: z.string().optional(),
  /** Service account key for Gmail (domain-wide delegation). Raw JSON, or a path to the key file. The JSON wins when both are set. */
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().optional(),

  /** `fake` enables the deterministic grid enrichment provider (demos and tests only). */
  GRID_PROVIDER: z.enum(["real", "fake"]).optional(),
  /** Hosts a Custom HTTP enrichment provider may call, comma separated (`host`, `host:port` or `*.domain`). Empty by default, so none can. */
  GRID_HTTP_ALLOWED_HOSTS: z.string().optional(),
  /** Cells one `grid.run` tick runs at the same time (1 to 16). Default 4. */
  GRID_RUN_CONCURRENCY: z.coerce.number().int().min(1).max(16).optional(),

  /** History pruning retention in days. Business data (sends, messages, enrollments, suppression) is never pruned. */
  RETENTION_JOB_RUNS_DAYS: z.coerce.number().int().min(1).default(30),
  RETENTION_INBOUND_EVENTS_DAYS: z.coerce.number().int().min(1).default(30),
  /** Dead-lettered (`failed`) provider events stay longer so a person can review them. */
  RETENTION_INBOUND_FAILED_DAYS: z.coerce.number().int().min(1).default(90),
  RETENTION_AI_JOBS_DAYS: z.coerce.number().int().min(1).default(30),

  /** Comma list of email domains tenants may connect as mailboxes. Required when AUTH_SIGNUP=open. */
  MAILBOX_ALLOWED_DOMAINS: z.string().optional(),
  AUTH_SIGNUP: z.enum(["invite-only", "open"]).default("invite-only"),
  RESEND_API_KEY: z.string().optional(),
  AUTH_EMAIL_FROM: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

/** Every variable the schema reads. The env-docs test compares this list with `.env.example` and `docs/configuration.md`. */
export const ENV_VARIABLES: string[] = Object.keys(schema.shape);

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(
    Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v])),
  );
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
