import { describe, expect, it } from "vitest";
import { readableMigrationError } from "../migration-error";

describe("readableMigrationError", () => {
  it("replaces drizzle's 'Failed query' message with the database's own", () => {
    const db = new Error("Migration 0012 stopped: 2 row(s) are test sends whose mailbox no longer exists. List them with: SELECT 1.");
    const wrapped = new Error("Failed query: SELECT pg_temp.t8_abort_if_rows(...)", { cause: db });
    const out = readableMigrationError(wrapped);
    expect(out.message).toBe(`Migration failed: ${db.message}`);
    expect(out.cause).toBe(wrapped);
  });

  it("returns an error without a cause unchanged", () => {
    const plain = new Error("boom");
    expect(readableMigrationError(plain)).toBe(plain);
  });

  it("wraps a non-error value", () => {
    expect(readableMigrationError("text").message).toBe("text");
  });
});
