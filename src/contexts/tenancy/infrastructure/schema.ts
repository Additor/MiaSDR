import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, users } from "@/contexts/identity/infrastructure/schema";

/**
 * Organization = tenant. Names match the Better Auth organization plugin
 * (teams are not enabled). Every business table in other contexts carries
 * `organization_id` referencing `organizations.id`.
 */

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  /** IANA zone used for due dates and day boundaries when a user has none. */
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: createdAt(),
  metadata: text("metadata"),
});

export const members = pgTable(
  "members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** owner | admin | member, comma-separated when a member holds several. */
    role: text("role").default("member").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("members_organization_user_uq").on(t.organizationId, t.userId),
    index("members_user_id_idx").on(t.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    /** pending | accepted | rejected | canceled */
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("invitations_organization_id_idx").on(t.organizationId), index("invitations_email_idx").on(t.email)],
);

/** Per-organization, per-channel overrides of the sending rules. A missing row means defaults. */
export const channelSettings = pgTable(
  "channel_settings",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    values: jsonb("values").$type<Record<string, unknown>>().default({}).notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.channel] })],
);

/**
 * Append-only audit of organization-level actions that have no person or
 * record to hang an event on: rename, test send, limits change, counter
 * reset, webhook replay, LinkedIn connect.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Dotted verb, for example organization.renamed, mailbox.test_sent, linkedin.limits_changed. */
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_org_created_idx").on(t.organizationId, t.createdAt),
    index("audit_log_org_action_idx").on(t.organizationId, t.action, t.createdAt),
    check("audit_log_action_ck", sql`length(btrim(${t.action})) > 0`),
  ],
);
