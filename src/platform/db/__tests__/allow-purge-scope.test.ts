import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { purgePersonHandling } from "@/contexts/conversations/infrastructure/person-purge";
import type { DbHandle } from "@/platform/db/client";

/**
 * `events` and `messages` are append-only; `ledger_reject_delete()` (migration 0013) lets a delete through only while the
 * transaction has `miasdr.allow_purge` on. The contact delete's `purgePersonHandling` is the one product path that turns
 * it on ("Contacts and Companies CRUD" in docs/decisions.md), and it turns it off before it returns. The integration tests
 * of the guards themselves also set it.
 */

const ROOT = path.resolve(__dirname, "../../../..");
const SRC = path.join(ROOT, "src");
const SELF = "src/platform/db/__tests__/allow-purge-scope.test.ts";
const PURGE = "src/contexts/conversations/infrastructure/person-purge.ts";
const ALLOWED = [
  PURGE,
  "src/platform/db/__tests__/append-only.integration.test.ts",
  "src/platform/db/__tests__/foreign-keys-checks.integration.test.ts",
  "src/platform/db/__tests__/immutability.integration.test.ts",
  "src/platform/db/__tests__/validators.integration.test.ts",
];
const SETTING = ["miasdr", "allow_purge"].join(".");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(ts|tsx|js|mjs|sql)$/.test(name)) out.push(full);
  }
  return out;
}

const relative = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

describe("miasdr.allow_purge scope", () => {
  it("is named only by the contact purge and the guard tests", () => {
    const naming = files(SRC)
      .map(relative)
      .filter((file) => file !== SELF && readFileSync(path.join(ROOT, file), "utf8").includes(SETTING))
      .sort();
    expect(naming).toEqual([...ALLOWED].sort());
  });

  it("is on for every delete of the purge and off when it returns", async () => {
    const statements: string[] = [];
    const dialect = new PgDialect();
    const tx = {
      execute: async (query: SQL) => {
        statements.push(dialect.sqlToQuery(query).sql.replace(/\s+/g, " ").trim());
        return [{ n: 0 }];
      },
    } as unknown as DbHandle;
    await purgePersonHandling(tx, "org", "person");
    const switches = statements.map((s, i) => [s.match(/set_config\('miasdr\.allow_purge', '(on|off)', true\)/)?.[1], i] as const).filter(([value]) => value);
    const deletes = statements.flatMap((s, i) => (/\bdelete from\b/.test(s) ? [i] : []));
    expect(switches.map(([value]) => value)).toEqual(["on", "off"]);
    expect(deletes.length).toBeGreaterThan(0);
    expect(Math.min(...deletes)).toBeGreaterThan(switches[0][1]);
    expect(Math.max(...deletes)).toBeLessThan(switches[1][1]);
    expect(switches[1][1]).toBe(statements.length - 1);
  });
});
