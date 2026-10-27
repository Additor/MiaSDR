import { describe, expect, it } from "vitest";
import * as script from "../../../../scripts/migrate.mjs";
import { MIGRATION_LOCK_KEY, MIGRATION_LOCK_TIMEOUT } from "../migrate";
import { readableMigrationError } from "../migration-error";
import { MIN_POSTGRES_MAJOR, UnsupportedPostgresError } from "../postgres-version";

/** scripts/migrate.mjs repeats three small pieces of src/shared/db because it runs under plain node. These tests keep the copies equal. */
describe("migrate.mjs and src/shared/db agree", () => {
  it("uses the advisory lock key of runMigrations", () => {
    expect(script.ADVISORY_LOCK_KEY).toBe(MIGRATION_LOCK_KEY);
  });

  it("uses the lock timeout of runMigrations", () => {
    expect(script.LOCK_TIMEOUT).toBe(MIGRATION_LOCK_TIMEOUT);
  });

  it("uses the same Postgres floor", () => {
    expect(script.MIN_POSTGRES_MAJOR).toBe(MIN_POSTGRES_MAJOR);
    expect(script.unsupportedVersionMessage(160004)).toBe(new UnsupportedPostgresError("16.4").message);
    expect(script.unsupportedVersionMessage(170000)).toBeNull();
    expect(script.unsupportedVersionMessage(170002)).toBeNull();
    expect(script.unsupportedVersionMessage(180000)).toBeNull();
  });

  it("unwraps a failed migration to the database message like readableMigrationError", () => {
    const db = new Error('column "x" does not exist');
    const wrapped = new Error("Failed query: alter table ...", { cause: db });
    expect(script.readableMigrationError(wrapped).message).toBe(readableMigrationError(wrapped).message);
    expect(script.readableMigrationError(wrapped).message).toBe('Migration failed: column "x" does not exist');
    const plain = new Error("plain");
    expect(script.readableMigrationError(plain).message).toBe(readableMigrationError(plain).message);
  });
});
