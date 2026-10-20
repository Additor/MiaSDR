import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "@/shared/env";
import * as schema from "./schema";

function createDb() {
  const e = env();
  const client = postgres(e.DATABASE_URL, {
    ssl: e.DATABASE_SSL === "disable" ? false : "require",
    max: e.DB_POOL_MAX,
    idle_timeout: 20,
  });
  return drizzle(client, { schema });
}

type Db = ReturnType<typeof createDb>;

/** The handle `db.transaction` passes to its callback. */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Either the pool or an open transaction. Ports take one so a caller can make several writes atomic. */
export type DbHandle = Db | DbTx;

const globalForDb = globalThis as unknown as { __miasdrDb?: Db };

/** The one Drizzle instance, created on first use (builds need no database). */
export const db: Db = new Proxy({} as Db, {
  get(_, prop) {
    globalForDb.__miasdrDb ??= createDb();
    const instance = globalForDb.__miasdrDb;
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

/** Runs `fn` in a transaction. Given an open transaction it nests as a savepoint, so the caller's rollback still undoes the work. */
export function inTransaction<T>(handle: DbHandle | undefined, fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return ((handle ?? db) as typeof db).transaction(fn);
}
