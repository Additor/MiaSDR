import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, integer, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "@/contexts/identity/infrastructure/schema";
import { people } from "@/contexts/leads/infrastructure/schema";
import { campaignEnrollments } from "@/contexts/outreach/infrastructure/schema";
import { createdAt, orgId, pk, tstz, updatedAt } from "@/platform/db/columns";

/**
 * Deals: the CRM side of the product. A lead becomes a contact when a person creates a deal from it (`people.lifecycle`,
 * migration 0025). One pipeline per organization: `deal_stages` is the ordered list of its steps. The reply taxonomy in
 * conversations (`pipelines`, `subcategories`) is a different thing and keeps its names.
 */

export const DEAL_STAGE_KINDS = ["open", "won", "lost"] as const;

/** CHECK needs literals: DDL cannot take bind parameters. Values are compile-time constants. */
const inList = (column: unknown, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", "))})`;

export const dealStages = pgTable(
  "deal_stages",
  {
    id: pk(),
    organizationId: orgId(),
    name: text("name").notNull(),
    /** Immutable (trigger in migration 0025). Won and Lost close a deal; the use case keeps open before won before lost. */
    kind: text("kind").notNull(),
    position: integer("position").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("deal_stages_id_org_uq").on(t.id, t.organizationId),
    // Target of the composite key from deals, so a deal's stage_kind is always the kind of its stage.
    unique("deal_stages_id_org_kind_uq").on(t.id, t.organizationId, t.kind),
    // Migration 0025 declares this one DEFERRABLE INITIALLY DEFERRED (a swap of two positions works inside a transaction).
    // Drizzle cannot express that, so ON CONFLICT cannot use it: the case-insensitive name index below is the arbiter.
    unique("deal_stages_org_position_uq").on(t.organizationId, t.position),
    uniqueIndex("deal_stages_org_name_uq").on(t.organizationId, sql`lower(${t.name})`),
    check("deal_stages_name_ck", sql`length(btrim(${t.name})) > 0 and length(${t.name}) <= 60`),
    check("deal_stages_kind_ck", inList(t.kind, DEAL_STAGE_KINDS)),
  ],
);

export const deals = pgTable(
  "deals",
  {
    id: pk(),
    organizationId: orgId(),
    personId: uuid("person_id").notNull(),
    stageId: uuid("stage_id").notNull(),
    /** Copy of the stage's kind, so the CHECKs below can read it. A move writes both columns in one statement. */
    stageKind: text("stage_kind").notNull(),
    title: text("title").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Minor units of `currency` (USD 2 decimals, KRW 0, KWD 3). */
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: text("currency"),
    expectedCloseOn: date("expected_close_on", { mode: "string" }),
    closedAt: tstz("closed_at"),
    lostReason: text("lost_reason"),
    stageChangedAt: tstz("stage_changed_at").defaultNow().notNull(),
    sourceEnrollmentId: uuid("source_enrollment_id"),
    idempotencyKey: text("idempotency_key"),
    /** Optimistic lock. */
    version: integer("version").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("deals_id_org_uq").on(t.id, t.organizationId),
    // Migration 0025 adds a trigger: the person must be a contact on insert, and person_id and organization_id never change.
    foreignKey({ name: "deals_person_fk", columns: [t.personId, t.organizationId], foreignColumns: [people.id, people.organizationId] }).onDelete("restrict"),
    foreignKey({
      name: "deals_stage_fk",
      columns: [t.stageId, t.organizationId, t.stageKind],
      foreignColumns: [dealStages.id, dealStages.organizationId, dealStages.kind],
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    // Migration 0025 writes `ON DELETE SET NULL (source_enrollment_id)`; Drizzle cannot express the column list.
    foreignKey({
      name: "deals_source_enrollment_fk",
      columns: [t.sourceEnrollmentId, t.organizationId],
      foreignColumns: [campaignEnrollments.id, campaignEnrollments.organizationId],
    }).onDelete("set null"),
    uniqueIndex("deals_idempotency_uq")
      .on(t.organizationId, t.personId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    // The board reads one stage at a time, newest move first. The contact page reads one person's deals.
    index("deals_org_stage_idx").on(t.organizationId, t.stageId, t.stageChangedAt.desc().nullsFirst()),
    index("deals_org_person_idx").on(t.organizationId, t.personId),
    check("deals_title_ck", sql`length(btrim(${t.title})) > 0 and length(${t.title}) <= 200`),
    check("deals_amount_ck", sql`${t.amountMinor} is null or (${t.amountMinor} >= 0 and ${t.amountMinor} <= 9007199254740991)`),
    check("deals_currency_pair_ck", sql`(${t.amountMinor} is null) = (${t.currency} is null)`),
    check("deals_closed_at_ck", sql`(${t.stageKind} <> 'open') = (${t.closedAt} is not null)`),
    check("deals_lost_reason_ck", sql`(${t.stageKind} = 'lost') = (${t.lostReason} is not null)`),
    check("deals_lost_reason_len_ck", sql`${t.lostReason} is null or length(${t.lostReason}) <= 500`),
    check("deals_version_ck", sql`${t.version} >= 0`),
  ],
);
