import postgres from "postgres";

/**
 * The supported floor is 17, the version CI and the bundled compose file run. The schema uses `UNIQUE NULLS NOT DISTINCT`
 * and `ON DELETE SET NULL (column)`, which need 15, so 15 and 16 may work but nothing tests them.
 */
export const MIN_POSTGRES_MAJOR = 17;

export class UnsupportedPostgresError extends Error {
  constructor(
    readonly detected: string,
    readonly required: number = MIN_POSTGRES_MAJOR,
  ) {
    super(
      `MiaSDR needs PostgreSQL ${required} or newer, but this database reports version ${detected}. ` +
        `Upgrade the server, or point DATABASE_URL at a PostgreSQL ${required}+ instance. See docs/database.md.`,
    );
    this.name = "UnsupportedPostgresError";
  }
}

/** `server_version_num` is major * 10000 + minor (170004 is 17.4). Returns null for anything that is not a positive integer. */
export function parseServerVersionNum(raw: string | number | null | undefined): number | null {
  const text = typeof raw === "number" ? String(raw) : (raw ?? "").trim();
  if (!/^\d{5,6}$/.test(text)) return null;
  return Number(text);
}

export function majorOf(versionNum: number): number {
  return Math.floor(versionNum / 10000);
}

/** "17.4" style text for messages. */
export function describeVersion(versionNum: number): string {
  return `${majorOf(versionNum)}.${versionNum % 10000}`;
}

/** Throws `UnsupportedPostgresError` when the version is below the minimum. An unreadable value passes: the caller already reached the server. */
export function checkVersion(raw: string | number | null | undefined, minMajor: number = MIN_POSTGRES_MAJOR): void {
  const num = parseServerVersionNum(raw);
  if (num === null) return;
  if (majorOf(num) < minMajor) throw new UnsupportedPostgresError(describeVersion(num), minMajor);
}

type Query = (strings: TemplateStringsArray) => PromiseLike<Array<{ server_version_num?: string }>>;

/** Reads `server_version_num` through any tagged-template client (a postgres.js handle or a test fake) and checks it. */
export async function assertPostgresSupported(query: Query): Promise<void> {
  const [row] = await query`select current_setting('server_version_num') as server_version_num`;
  checkVersion(row?.server_version_num);
}

/**
 * Startup check. Opens a short-lived connection, so it works before the shared pool exists. A connection failure is not
 * this check's concern (the app reports it where it first uses the database), so it returns without throwing.
 */
export async function verifyPostgresVersion(url: string, ssl: boolean | "require"): Promise<void> {
  const client = postgres(url, { ssl, max: 1, connect_timeout: 10, onnotice: () => undefined });
  try {
    await assertPostgresSupported(client as unknown as Query);
  } catch (error) {
    if (error instanceof UnsupportedPostgresError) throw error;
  } finally {
    await client.end({ timeout: 2 }).catch(() => undefined);
  }
}
