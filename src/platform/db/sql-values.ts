import { sql, type SQL } from "drizzle-orm";

/** `(a, b, c)` as bound parameters: an `in` list for raw SQL built from a domain constant instead of a copied literal. */
export const sqlValues = (values: readonly string[]): SQL => sql`(${sql.join(values.map((v) => sql`${v}`), sql`, `)})`;

/** `(a::uuid, b::uuid)` as bound parameters: an `in` list of ids for raw SQL. */
export const uuidList = (ids: readonly string[]): SQL => sql`(${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;

/** `column in ('a', 'b')` with literals, for a CHECK constraint: DDL cannot take bind parameters. Values are compile-time constants. */
export const inList = (column: unknown, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "))})`;

/** The rows of a raw `db.execute`, typed. The driver returns an array-like result. */
export const rowsOf = <T>(result: unknown) => result as unknown as T[];
