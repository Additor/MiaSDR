import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe } from "vitest";

/** The migrated Postgres the integration tests run against. Unset, every `describeDb` suite skips. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** `describe` when a test database is set, `describe.skip` otherwise. */
export const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

const SECRET = "t".repeat(40);

/** The environment app code reads, pointed at the test database. `overrides` add or replace variables. */
export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_SSL: "disable",
    APP_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: SECRET,
    INTEGRATION_CREDENTIALS_KEY: SECRET,
    UNSUBSCRIBE_SECRET: SECRET,
    ...overrides,
  };
}

/**
 * Sets `testEnv(overrides)` before the suite and puts every touched variable back after it, so one file's settings never
 * leak into the next. Call it at the top of a `describeDb` block, before any `beforeAll` that imports app code.
 */
export function useTestEnv(overrides: Record<string, string | undefined> = {}): void {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [key, value] of Object.entries(testEnv(overrides))) {
      saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** A client on the test database for seeding and assertions. End it in `afterAll`. */
export function testSql(options: postgres.Options<Record<string, postgres.PostgresType>> = {}) {
  return postgres(TEST_DATABASE_URL ?? "", { max: 2, onnotice: () => undefined, ...options });
}

/** A short unique suffix for slugs, emails and keys. */
export const uniqueKey = (): string => randomUUID().slice(0, 12);

/**
 * Waits until at least `count` other sessions on this database wait on a lock. Use it where a test needs another
 * transaction to be blocked before it goes on; a sleep only guesses, and a slow runner turns the guess into a false pass.
 */
export async function waitForLockWaiters(sql: postgres.Sql, count = 1, timeoutMs = 10_000, queryLike?: string): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    // `queryLike` (an ILIKE pattern such as '%for share%') narrows the count to the statement the test is waiting for.
    const [{ waiting }] = await sql<{ waiting: number }[]>`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
        and (${queryLike ?? null}::text is null or query ilike ${queryLike ?? "%"})`;
    if (waiting >= count) return;
    if (Date.now() > until) throw new Error(`expected ${count} lock waiter(s), saw ${waiting}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export interface TestOrg {
  organizationId: string;
  userId: string;
  slug: string;
}

/** An organization with one owner. `dropOrgs` removes both; the organization's rows go with it by cascade. */
export async function createTestOrg(sql: postgres.Sql, name = "Test Org", role = "owner"): Promise<TestOrg> {
  const slug = `t-${uniqueKey()}`;
  const [{ id: organizationId }] = await sql<{ id: string }[]>`insert into organizations (name, slug) values (${name}, ${slug}) returning id`;
  const [{ id: userId }] = await sql<{ id: string }[]>`insert into users (name, email, email_verified) values (${name + " Owner"}, ${slug + "@example.test"}, true) returning id`;
  await sql`insert into members (organization_id, user_id, role) values (${organizationId}, ${userId}, ${role})`;
  return { organizationId, userId, slug };
}

/**
 * Deletes the organizations and the users a test made. Errors propagate: a cleanup that fails leaves rows behind for the
 * next file, and the suite should say so.
 */
export async function dropOrgs(sql: postgres.Sql, orgs: Array<Pick<TestOrg, "organizationId"> & Partial<Pick<TestOrg, "userId">>>, extraUserIds: string[] = []): Promise<void> {
  const orgIds = orgs.map((o) => o.organizationId);
  const userIds = [...orgs.flatMap((o) => (o.userId ? [o.userId] : [])), ...extraUserIds];
  await sql.begin(async (tx) => {
    // Deals point at people with ON DELETE RESTRICT, so they go first; the cascade from organizations takes the rest.
    if (orgIds.length > 0) {
      await tx`delete from deals where organization_id = any(${orgIds})`;
      await tx`delete from organizations where id = any(${orgIds})`;
    }
    if (userIds.length > 0) await tx`delete from users where id = any(${userIds})`;
  });
}
