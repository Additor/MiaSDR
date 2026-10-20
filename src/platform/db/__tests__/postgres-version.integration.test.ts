import { afterAll, expect, it } from "vitest";
import { describeDb, TEST_DATABASE_URL, testSql } from "../../../test-support/db";
import { MIN_POSTGRES_MAJOR, assertPostgresSupported, majorOf, parseServerVersionNum, verifyPostgresVersion } from "../postgres-version";

/** The check against the real test database (Postgres 17 or newer, as the docs require). Needs TEST_DATABASE_URL. */
describeDb("postgres version check", () => {
  const sql = testSql({ max: 1 });
  afterAll(async () => {
    await sql.end();
  });

  it("reads server_version_num and accepts the test database", async () => {
    const [{ v }] = await sql`select current_setting('server_version_num') as v`;
    const num = parseServerVersionNum(v);
    expect(num).not.toBeNull();
    expect(majorOf(num as number)).toBeGreaterThanOrEqual(MIN_POSTGRES_MAJOR);
    await expect(assertPostgresSupported(sql as never)).resolves.toBeUndefined();
  });

  it("verifyPostgresVersion passes against the test database", async () => {
    await expect(verifyPostgresVersion(TEST_DATABASE_URL ?? "", false)).resolves.toBeUndefined();
  });
});
