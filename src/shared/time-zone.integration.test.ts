import { afterAll, expect, it } from "vitest";
import { describeDb, testSql } from "../test-support/db";
import { canonicalTimeZone, LEGACY_ZONE_ALIASES } from "./time-zone";

/** Needs TEST_DATABASE_URL. Postgres builds without backward links reject the legacy ids, so every target must be accepted. */
describeDb("time zone aliases against Postgres", () => {
  const sql = testSql({ max: 1 });
  afterAll(async () => {
    await sql.end();
  });

  it.each(Object.entries(LEGACY_ZONE_ALIASES))("%s maps to %s, which Postgres accepts", async (legacy, current) => {
    const zone = canonicalTimeZone(legacy);
    expect(zone).toBe(current);
    const [row] = await sql`select (now() at time zone ${zone as string}) as local`;
    expect(row.local).toBeInstanceOf(Date);
  });
});
