import { timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/contexts/tenancy/infrastructure/schema";

export const pk = () => uuid("id").defaultRandom().primaryKey();

export const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

/** Tenant column. Every aggregate root and every table a worker reads without its parent carries one. */
export const orgId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

export const tstz = (name: string) => timestamp(name, { withTimezone: true });
