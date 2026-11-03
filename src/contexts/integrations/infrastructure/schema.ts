import { sql } from "drizzle-orm";
import { boolean, check, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, orgId, pk, updatedAt } from "@/platform/db/columns";

/**
 * Connected third-party accounts, one row per connection per organization.
 * `kind` is `platform` (Unipile), `ai`, or `enrichment`: a grid provider's key sits under an account named
 * `enrichment:<provider key>` that only `grid_providers.account_id` points at. Settings, Integrations lists the other two kinds.
 */
export const integrationAccounts = pgTable(
  "integration_accounts",
  {
    id: pk(),
    organizationId: orgId(),
    /** platform | ai | enrichment */
    kind: text("kind").notNull(),
    /** unipile, anthropic, openrouter, vercel-ai-gateway, enrichment:<provider key> */
    key: text("key").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("integration_accounts_org_key_uq").on(t.organizationId, t.key),
    unique("integration_accounts_id_org_uq").on(t.id, t.organizationId),
    check("integration_accounts_kind_ck", sql`${t.kind} in ('enrichment', 'platform', 'ai')`),
  ],
);

/** One AES-256-GCM blob per account (`v2:<keyId>:<iv>:<tag>:<ciphertext>`). Plaintext exists only server-side right before a call. */
export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    accountId: uuid("account_id")
      .primaryKey()
      .references(() => integrationAccounts.id, { onDelete: "cascade" }),
    encryptedPayload: text("encrypted_payload").notNull(),
    encryptionVersion: text("encryption_version").notNull().default("v2"),
    updatedAt: updatedAt(),
  },
  (t) => [check("integration_credentials_envelope_ck", sql`${t.encryptedPayload} like ${t.encryptionVersion} || ':%'`)],
);
