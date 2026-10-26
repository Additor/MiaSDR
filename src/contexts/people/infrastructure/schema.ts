import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "@/contexts/identity/infrastructure/schema";
import { createdAt, orgId, pk, tstz, updatedAt } from "@/platform/db/columns";

/**
 * One `people` row per human across all channels. Importing creates or
 * updates people only; a CRM record starts when a lead replies.
 */

export const companies = pgTable(
  "companies",
  {
    id: pk(),
    organizationId: orgId(),
    /** Normalized domain, the company identity. */
    domain: text("domain").notNull(),
    name: text("name"),
    linkedinUrl: text("linkedin_url"),
    custom: jsonb("custom").$type<Record<string, unknown>>().default({}).notNull(),
    /** Unmapped import columns, kept verbatim and size-capped. Source data, never read by business logic. */
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    /** grid:<tableId> | import:<runId> | manual */
    source: text("source"),
    /**
     * When the company entered the CRM: Add company, a merge into it, or a use case that moved its last contact away. Companies
     * lists a company with this set or with a contact. No trigger writes it and nothing clears it.
     */
    crmListedAt: tstz("crm_listed_at"),
    /** Optimistic lock. Every company write sets `version = version + 1`, so a merge or delete preview sees a change. */
    version: integer("version").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("companies_raw_size_ck", sql`${t.raw} is null or octet_length(${t.raw}::text) <= 262144`),
    check("companies_version_ck", sql`${t.version} >= 0`),
    unique("companies_org_domain_uq").on(t.organizationId, t.domain),
    unique("companies_id_org_uq").on(t.id, t.organizationId),
  ],
);

/**
 * Other domains of a company: the domain of a company that merged into it, and that company's own other domains. A domain is
 * a company domain or an alias in one organization, never both; the domain lock of every writer keeps it so, and two guard
 * triggers (`companies_domain_not_alias_trg`, `company_aliases_not_domain_trg`) back it up. Rows move to
 * the kept company on a later merge, so `company_id` is not immutable.
 */
export const companyDomainAliases = pgTable(
  "company_domain_aliases",
  {
    id: pk(),
    organizationId: orgId(),
    companyId: uuid("company_id").notNull(),
    /** Normalized like `companies.domain`. */
    domain: text("domain").notNull(),
    /** The company the merge removed. No foreign key: the row is gone. The merge replay reads it. */
    mergedCompanyId: uuid("merged_company_id"),
    /** The removed company's name, for the Details row "Other domains". */
    mergedName: text("merged_name"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    // A deleted company takes its other domains with it.
    foreignKey({ name: "company_domain_aliases_company_fk", columns: [t.companyId, t.organizationId], foreignColumns: [companies.id, companies.organizationId] }).onDelete("cascade"),
    unique("company_domain_aliases_org_domain_uq").on(t.organizationId, t.domain),
    index("company_domain_aliases_org_company_idx").on(t.organizationId, t.companyId),
    check("company_domain_aliases_domain_ck", sql`${t.domain} = lower(btrim(${t.domain})) and length(${t.domain}) between 3 and 253`),
  ],
);

export const people = pgTable(
  "people",
  {
    id: pk(),
    organizationId: orgId(),
    email: text("email"),
    /** Bare profile slug, never a URL. */
    linkedinSlug: text("linkedin_slug"),
    /** Canonical https://www.linkedin.com/in/<slug>/ for person profiles; other LinkedIn URLs are kept as given, without a slug. */
    linkedinUrl: text("linkedin_url"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    fullName: text("full_name"),
    title: text("title"),
    profilePictureUrl: text("profile_picture_url"),
    /** E.164. */
    phone: text("phone"),
    companyId: uuid("company_id"),
    custom: jsonb("custom").$type<Record<string, unknown>>().default({}).notNull(),
    /** Unmapped import columns, kept verbatim and size-capped. Source data, never read by business logic. */
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    source: text("source"),
    /**
     * `lead` or `contact`. Add contact inserts a contact; a lead becomes one when a deal is created from it or someone makes it a
     * contact, and never goes back (trigger `people_lifecycle_trg`).
     */
    lifecycle: text("lifecycle").notNull().default("lead"),
    /** Set once, when the person became a contact. */
    convertedAt: tstz("converted_at"),
    /** The idempotency key of the Add contact request that created the person; nothing else writes it. */
    creationKey: text("creation_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("people_raw_size_ck", sql`${t.raw} is null or octet_length(${t.raw}::text) <= 262144`),
    // Partial: NULLs would otherwise collide.
    uniqueIndex("people_org_email_uq")
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
    uniqueIndex("people_org_linkedin_uq")
      .on(t.organizationId, t.linkedinSlug)
      .where(sql`${t.linkedinSlug} is not null`),
    // Target of composite FKs from other contexts, so a child can never point at another tenant's person.
    unique("people_id_org_uq").on(t.id, t.organizationId),
    // The migration writes `ON DELETE SET NULL (company_id)`; Drizzle cannot express the column list.
    foreignKey({ name: "people_company_fk", columns: [t.companyId, t.organizationId], foreignColumns: [companies.id, companies.organizationId] }).onDelete("set null"),
    index("people_org_company_idx").on(t.organizationId, t.companyId),
    // Lead list order (created, either direction: a backward scan serves `desc`) and the ascending name sort.
    index("people_org_created_idx").on(t.organizationId, t.createdAt, t.id),
    index("people_org_name_idx").on(t.organizationId, sql`lower(${t.fullName})`, t.id),
    check("people_lifecycle_ck", sql`${t.lifecycle} in ('lead', 'contact')`),
    check("people_converted_at_ck", sql`(${t.lifecycle} = 'contact') = (${t.convertedAt} is not null)`),
    // Contacts list, newest conversion first. Contacts are few among many leads, so the created_at index would scan them all.
    // Queries write the predicate as a literal so a generic plan can still use this index.
    index("people_org_contacts_idx")
      .on(t.organizationId, t.convertedAt.desc().nullsFirst(), t.id)
      .where(sql`${t.lifecycle} = 'contact'`),
    // The range of MAX_IDEMPOTENCY_KEY (deals.ts), which the app checks too.
    check("people_creation_key_ck", sql`${t.creationKey} is null or char_length(${t.creationKey}) between 8 and 200`),
    uniqueIndex("people_creation_key_uq")
      .on(t.organizationId, t.creationKey)
      .where(sql`${t.creationKey} is not null`),
  ],
);

/** Definitions of custom lead fields. Values live in `people.custom` / `companies.custom`; no runtime DDL. */
export const entityColumns = pgTable(
  "entity_columns",
  {
    id: pk(),
    organizationId: orgId(),
    entity: text("entity").notNull(),
    /** Generated, immutable. `x_` prefix for user columns. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    isCore: boolean("is_core").notNull().default(false),
    /** Fractional index for ordering. */
    position: doublePrecision("position").notNull().default(0),
    archivedAt: tstz("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("entity_columns_org_entity_key_uq").on(t.organizationId, t.entity, t.key),
    check("entity_columns_entity_ck", sql`${t.entity} in ('people', 'companies')`),
    check("entity_columns_key_ck", sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
  ],
);

/** One CSV/XLSX import. Stores the column mapping so a re-import is one click. */
export const importRuns = pgTable(
  "import_runs",
  {
    id: pk(),
    organizationId: orgId(),
    filename: text("filename"),
    destination: text("destination").notNull().default("database"),
    /** Campaign to enroll into when destination is `campaign`. Reference by value, no FK across contexts. */
    destinationCampaignId: uuid("destination_campaign_id"),
    mapping: jsonb("mapping").$type<Record<string, string>>().default({}).notNull(),
    stats: jsonb("stats").$type<Record<string, number>>().default({}).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    check("import_runs_destination_ck", sql`${t.destination} in ('database', 'campaign')`),
    // `destination_campaign_id -> campaigns (id, organization_id) ON DELETE SET NULL (destination_campaign_id)` lives in
    // the migration SQL only: the target table is in the outreach schema, which imports this one.
    index("import_runs_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);
