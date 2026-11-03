import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, users } from "@/contexts/identity/infrastructure/schema";
import { organizations } from "@/contexts/tenancy/infrastructure/schema";

/**
 * Tokens for the MCP endpoint, one row per token, each tied to one person in one organization. A personal token (`pat`)
 * keeps only the SHA-256 hash of its secret, which is shown once; an OAuth grant (`oauth`) keeps the authorization
 * server's grant id instead. A token is revoked, never deleted, so the agent actions it took keep their source.
 */
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"pat" | "oauth">().notNull(),
    name: text("name").notNull(),
    /** Hex SHA-256 of the secret. `pat` only. */
    tokenHash: text("token_hash"),
    /** The last characters of the secret, so a person can tell tokens apart. `pat` only. */
    tokenHint: text("token_hint"),
    /** The authorization server's grant. `oauth` only. */
    oauthGrantId: text("oauth_grant_id"),
    /** `mcp:read`, `mcp:write`, `mcp:send`, `mcp:spend`, `mcp:irreversible` (agent-access/domain/mcp-policy.ts). */
    scopes: text("scopes").array().notNull(),
    /** The organization's `agentSendEpoch` when the token was made. A send token from an older epoch cannot send. */
    policyEpoch: integer("policy_epoch").notNull().default(0),
    /** The organization's `agentSpendEpoch` when the token was made. A spend token from an older epoch cannot spend. */
    spendEpoch: integer("spend_epoch").notNull().default(0),
    /** The organization's `agentIrreversibleEpoch` when the token was made. */
    irreversibleEpoch: integer("irreversible_epoch").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("mcp_tokens_token_hash_uq").on(t.tokenHash),
    unique("mcp_tokens_oauth_grant_uq").on(t.oauthGrantId),
    // The target of the organization-paired foreign keys from tables that point at a token.
    unique("mcp_tokens_id_org_uq").on(t.id, t.organizationId),
    index("mcp_tokens_org_user_idx").on(t.organizationId, t.userId),
    check("mcp_tokens_kind_ck", sql`${t.kind} in ('pat', 'oauth')`),
    check(
      "mcp_tokens_secret_ck",
      sql`(${t.kind} = 'pat' and ${t.tokenHash} is not null and ${t.oauthGrantId} is null) or (${t.kind} = 'oauth' and ${t.oauthGrantId} is not null and ${t.tokenHash} is null and ${t.tokenHint} is null)`,
    ),
    check("mcp_tokens_name_ck", sql`length(btrim(${t.name})) between 1 and 100`),
    check("mcp_tokens_policy_epoch_ck", sql`${t.policyEpoch} >= 0`),
    check("mcp_tokens_spend_epoch_ck", sql`${t.spendEpoch} >= 0`),
    check("mcp_tokens_irreversible_epoch_ck", sql`${t.irreversibleEpoch} >= 0`),
  ],
);

/**
 * What agents reserved in an organization on one UTC day, against the daily limits in its MCP settings:
 * `spend_cents`, `search_leads` or `irreversible` (`agent-access/application/mcp-agent-usage.ts`). Pruned after a few days.
 */
export const mcpAgentUsage = pgTable(
  "mcp_agent_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind").notNull(),
    amount: integer("amount").notNull(),
  },
  (t) => [
    unique("mcp_agent_usage_org_day_kind_uq").on(t.organizationId, t.day, t.kind),
    check("mcp_agent_usage_kind_ck", sql`${t.kind} in ('spend_cents', 'search_leads', 'irreversible')`),
    check("mcp_agent_usage_amount_ck", sql`${t.amount} >= 0`),
    index("mcp_agent_usage_day_idx").on(t.day),
  ],
);

/**
 * MCP request counts: one fixed window per token and bucket (`agent-access/domain/mcp-rate-limit.ts`). A request
 * updates its row in place, so the table holds at most one row per token and bucket and needs no prune.
 */
export const mcpRateLimits = pgTable(
  "mcp_rate_limits",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id").notNull(),
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.tokenId, t.bucket] }),
    foreignKey({ name: "mcp_rate_limits_token_fk", columns: [t.tokenId, t.organizationId], foreignColumns: [mcpTokens.id, mcpTokens.organizationId] }).onDelete("cascade"),
    check("mcp_rate_limits_count_ck", sql`${t.count} >= 1`),
  ],
);

/**
 * One row per MCP tool call, for the activity list on Settings, AI agents (MCP). `target` holds the ids the call named
 * (`conversationId`, `personId` and the like), never text from the call, so the log keeps no copy of a lead's data. The
 * history prune deletes rows older than `RETENTION_MCP_TOOL_CALLS_DAYS`.
 */
export const mcpToolCalls = pgTable(
  "mcp_tool_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id").notNull(),
    tool: text("tool").notNull(),
    /** The tool's `action` input, for tools that take one. */
    action: text("action"),
    /** `read` for a read tool, `write` for one that can change data. */
    kind: text("kind").$type<"read" | "write">().notNull(),
    target: jsonb("target").$type<Record<string, string>>().notNull().default({}),
    /** Null when the call succeeded; else the error code the agent got. */
    errorCode: text("error_code"),
    clientName: text("client_name"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "mcp_tool_calls_token_fk", columns: [t.tokenId, t.organizationId], foreignColumns: [mcpTokens.id, mcpTokens.organizationId] }).onDelete("cascade"),
    index("mcp_tool_calls_org_created_idx").on(t.organizationId, t.createdAt),
    index("mcp_tool_calls_created_idx").on(t.createdAt),
    check("mcp_tool_calls_kind_ck", sql`${t.kind} in ('read', 'write')`),
    check("mcp_tool_calls_duration_ck", sql`${t.durationMs} >= 0`),
  ],
);
