import type { HttpMethod } from "./route-client";

/*
 * What the route matrix needs to know about each route that the source cannot tell it.
 *
 * - `PUBLIC_ROUTES` are the routes that do not need a session. Each carries its reason and its own test in the
 *   matrix. A route that is in neither this list nor `ROUTES` fails the test, so a new route cannot ship unchecked.
 * - `ROUTES` lists every protected route with its path ids and every exported handler. `admin` marks a handler
 *   that only an owner or admin may call. `valid` is a body that passes validation, so a check that wants a 404
 *   or a 403 is not answered with a 400 first. A handler that reads its body is found from the source.
 */

export const PUBLIC_ROUTES: Record<string, string> = {
  "auth/[...all]": "Better Auth's own endpoints (sign-in, sign-up, reset). Covered by the auth integration tests.",
  "health": "Liveness probe.",
  "jobs/tick": "Scheduler entry point. Authenticated by the CRON_SECRET bearer token.",
  "outreach/unsubscribe": "Unsubscribe link in outgoing mail. Authenticated by a signed token.",
  "setup": "First-run setup. Answers 409 once a user exists.",
  "webhooks/dev-fakes": "Test controls. 404 unless E2E_FAKE_CONTROLS=1 outside production.",
  "webhooks/unipile": "LinkedIn webhook. Authenticated by a per-organization secret.",
  "webhooks/unipile-account": "Unipile hosted-auth callback. Authenticated by a per-link secret in the URL, stored as a hash.",
  "dev/inbound": "Test helper. 404 unless E2E_DEV_HELPERS=1 outside production. Behind the proxy gate, but its handler checks no session.",
};

/** A path id: the table its rows live in, and the columns of that row that name the ids of the other path params. */
export interface IdSpec {
  table: string | null;
  /** A value to use for a path param that names no row (an analytics view). */
  sample?: string;
  /** `{ id: "campaign_id" }` means the route's `id` param is this row's `campaign_id`. `"enrollment_id>campaign_enrollments.campaign_id"` follows a foreign key first. */
  links?: Record<string, string>;
  /** Column values the seeded row needs so the route finds it in the state it expects. */
  force?: Record<string, unknown>;
}

export interface HandlerSpec {
  admin?: boolean;
  /** A body that passes validation. Defaults to `{}`. */
  valid?: unknown;
  /** Query string every call needs. */
  query?: Record<string, string>;
  /** The body is multipart, not JSON. */
  form?: boolean;
  /** The handler treats an unreadable body as an empty one on purpose, so a malformed body is not a 400. */
  lenientBody?: boolean;
  /** A 404 for a seeded row of the caller's own organization is correct here (the row is not in the state the call needs). */
  mayNotFindOwnRow?: boolean;
  /** The id is the credential, as in an invitation link: another organization's id answers 200 with a minimal view for a stranger, so the foreign-id 404 check does not apply. The leak check below still covers it. */
  idIsCapability?: boolean;
}

export interface RouteSpec {
  ids?: Record<string, IdSpec | string | null>;
  handlers: Partial<Record<HttpMethod, HandlerSpec>>;
}

const EMAIL_STEPS = [{ stepNumber: 1, kind: "email", subject: "Hello", body: "Hi there", waitDays: 0 }];
const LINKEDIN_STEPS = [{ stepNumber: 1, kind: "invitation", body: "Hi", waitDays: 0 }];
const emailCampaign: IdSpec = { table: "campaigns", force: { channel: "email", steps: EMAIL_STEPS } };
const linkedinCampaign: IdSpec = { table: "campaigns", force: { channel: "linkedin", steps: LINKEDIN_STEPS } };

const SAMPLE_UUID = "00000000-0000-4000-8000-000000000001";
const batch: IdSpec = { table: "linkedin_search_batches", force: { kind: "bulk" } };
const admin = (valid?: unknown): HandlerSpec => ({ admin: true, ...(valid === undefined ? {} : { valid }) });
const ok = (valid?: unknown): HandlerSpec => (valid === undefined ? {} : { valid });
/** A person at lifecycle `contact` (the CHECK of 0025 wants `converted_at` with it). */
const contact: IdSpec = { table: "people", force: { lifecycle: "contact", converted_at: new Date("2026-10-19T00:00:00Z") } };

export const ROUTES: Record<string, RouteSpec> = {
  "analytics/[view]": { ids: { view: { table: null, sample: "campaigns" } } , handlers: { GET: ok() } },
  "campaigns": { handlers: { GET: ok(), POST: ok() } },
  "campaigns/[id]": { ids: { id: emailCampaign }, handlers: { PATCH: ok(), DELETE: ok() } },
  "campaigns/[id]/after-reply": { ids: { id: emailCampaign }, handlers: { GET: ok(), PUT: ok({ mode: "handoff" }) } },
  "campaigns/[id]/archive": { ids: { id: emailCampaign }, handlers: { POST: ok({ archived: true }) } },
  "campaigns/[id]/enroll": { ids: { id: emailCampaign }, handlers: { POST: ok() } },
  "campaigns/[id]/enrollments/[enrollmentId]": { ids: { enrollmentId: { table: "campaign_enrollments", force: { channel: "email" }, links: { id: "campaign_id" } } }, handlers: { DELETE: ok() } },
  "campaigns/[id]/enrollments/remove": { ids: { id: emailCampaign }, handlers: { POST: ok({ ids: [SAMPLE_UUID] }) } },
  "campaigns/[id]/enrollments/restore": { ids: { id: emailCampaign }, handlers: { POST: ok({ ids: [SAMPLE_UUID] }) } },
  "campaigns/[id]/preview": { ids: { id: emailCampaign }, handlers: { POST: ok({ step: 1 }) } },
  "campaigns/[id]/status": { ids: { id: emailCampaign }, handlers: { POST: ok({ status: "active" }) } },
  "campaigns/[id]/sends/[sendId]/resolve": { ids: { sendId: { table: "sends", force: { status: "unknown" }, links: { id: "enrollment_id>campaign_enrollments.campaign_id" } } }, handlers: { POST: admin({ outcome: "delivered" }) } },

  "companies": { handlers: { GET: ok(), POST: ok({ domain: "matrix-example.com" }) } },
  "companies/[id]": { ids: { id: "companies" }, handlers: { GET: ok(), PATCH: ok({ name: "Acme" }), DELETE: { query: { expectedVersion: "0" } } } },
  // The other company does not exist, so a valid call answers 404.
  "companies/[id]/merge": {
    ids: { id: "companies" },
    handlers: { POST: { valid: { otherId: SAMPLE_UUID, expected: { keptVersion: 0, otherVersion: 0, keptPeople: 0, otherPeople: 0 } }, mayNotFindOwnRow: true } },
  },
  "companies/[id]/merge/preview": { ids: { id: "companies" }, handlers: { POST: { valid: { otherId: SAMPLE_UUID }, mayNotFindOwnRow: true } } },
  "companies/resolve": { handlers: { GET: { query: { domain: "matrix-example.com" } } } },
  "companies/search": { handlers: { GET: { query: { q: "matrix", all: "1" } } } },
  "contacts": { handlers: { GET: ok(), POST: ok({ email: "matrix@example.com", idempotencyKey: "key-12345678" }) } },
  // The sends count is wrong on purpose, so a valid call answers 409 counts_changed and deletes nothing.
  "contacts/[id]": {
    ids: { id: contact },
    handlers: { DELETE: { query: { deals: "0", notes: "0", tasks: "0", events: "0", conversations: "0", messages: "0", sends: "9" }, mayNotFindOwnRow: true } },
  },
  "contacts/[id]/delete-preview": { ids: { id: contact }, handlers: { GET: ok() } },
  "contacts/export": { handlers: { GET: ok(), POST: ok({ ids: [SAMPLE_UUID] }) } },
  "contacts/ids": { handlers: { GET: ok() } },

  "actions": { handlers: { GET: ok() } },
  "reply-categories": { handlers: { GET: ok() } },
  "classifications/[id]/acknowledge": { ids: { id: "classifications" }, handlers: { POST: ok() } },
  "classifications/[id]/undo": { ids: { id: "classifications" }, handlers: { POST: ok() } },
  "identity-exceptions": { handlers: { GET: ok() } },
  "identity-exceptions/[id]": { ids: { id: "identity_exceptions" }, handlers: { PATCH: ok({ status: "ignored" }) } },
  "people/[personId]/dnc": { ids: { personId: "people" }, handlers: { POST: ok({ enabled: true, reason: "asked" }) } },
  "people/dnc": { handlers: { POST: ok({ ids: [SAMPLE_UUID], reason: "asked" }) } },
  "records/[id]": { ids: { id: "records" }, handlers: { GET: ok() } },
  "records/[id]/close": { ids: { id: "records" }, handlers: { POST: ok({ reason: "done" }) } },
  "records/[id]/notes": { ids: { id: "records" }, handlers: { POST: ok({ body: "note" }) } },
  "records/[id]/notes/[noteId]": { ids: { noteId: { table: "notes", links: { id: "record_id" } } }, handlers: { PATCH: ok({ body: "edited" }), DELETE: ok() } },
  "records/[id]/tasks": { ids: { id: "records" }, handlers: { GET: ok(), POST: ok({ name: "Call back" }) } },
  "tasks": { handlers: { GET: ok() } },
  "tasks/[id]": { ids: { id: "tasks" }, handlers: { PATCH: ok({ name: "Renamed" }), DELETE: ok() } },
  "records/[id]/reopen": { ids: { id: "records" }, handlers: { POST: ok() } },
  "records/[id]/after-reply": { ids: { id: "records" }, handlers: { GET: ok(), POST: ok({ action: "pause" }) } },
  "records/[id]/assignee": { ids: { id: "records" }, handlers: { POST: ok({ action: "claim" }) } },
  "records/[id]/stage": { ids: { id: "records" }, handlers: { POST: ok({ categoryKey: "interested", subcategoryId: null, expectedContextVersion: 0 }) } },
  "send-attempts/[id]/reconcile": { ids: { id: "send_attempts" }, handlers: { POST: ok({ delivered: true, note: "checked" }) } },
  "settings/replies": { handlers: { GET: ok(), PATCH: admin() } },
  "settings/sending-pause": { handlers: { GET: ok(), PUT: admin({ paused: false }) } },
  "suppressions": { handlers: { GET: ok(), POST: admin({ text: "matrix-suppressed@example.com" }) } },
  "suppressions/[id]": { ids: { id: { table: "suppression_list", force: { reason: "manual", added_in_settings: true } } }, handlers: { DELETE: admin() } },
  "settings/replies/ai-instructions": { handlers: { GET: ok(), PUT: admin() } },
  "reply-categories/subcategories": { handlers: { GET: ok(), POST: admin() } },
  "reply-categories/subcategories/[id]": { ids: { id: "subcategories" }, handlers: { PATCH: admin({ name: "renamed" }), DELETE: admin() } },

  "deal-stages": { handlers: { GET: ok(), POST: admin({ name: "Matrix stage", kind: "open" }) } },
  "deal-stages/[id]": { ids: { id: "deal_stages" }, handlers: { PATCH: admin({ name: "Renamed by matrix" }), DELETE: admin() } },
  "deal-stages/order": { handlers: { PUT: admin({ ids: [] }) } },
  "deal-stages/defaults": { handlers: { POST: admin() } },
  "deals": { handlers: { GET: ok(), POST: ok({ personId: SAMPLE_UUID, idempotencyKey: "key-12345678" }) } },
  "deals/[id]": { ids: { id: "deals" }, handlers: { GET: ok(), PATCH: ok({ expectedVersion: 0, title: "Renamed by matrix" }), DELETE: ok() } },
  "deals/[id]/stage": { ids: { id: "deals" }, handlers: { POST: ok({ stageId: SAMPLE_UUID, expectedVersion: 0 }) } },

  "drafts/[id]": { ids: { id: "drafts" }, handlers: { PATCH: ok({ revision: 1, bodyText: "x" }) } },
  "drafts/[id]/discard": { ids: { id: "drafts" }, handlers: { POST: ok() } },
  "drafts/[id]/regenerate": { ids: { id: "drafts" }, handlers: { POST: { lenientBody: true } } },
  "drafts/[id]/resolve": { ids: { id: "drafts" }, handlers: { POST: ok({ outcome: "delivered", note: "checked" }) } },
  "drafts/[id]/send": { ids: { id: "drafts" }, handlers: { POST: ok({ revision: 1, idempotencyKey: "key-12345678" }) } },

  "grid/folders": { handlers: { GET: ok(), POST: ok() } },
  "grid/folders/[folderId]": { ids: { folderId: "grid_folders" }, handlers: { GET: ok(), PATCH: ok(), DELETE: ok() } },
  "grid/providers": { handlers: { GET: ok(), POST: admin({ adapter: "fake" }) } },
  "grid/providers/[id]": { ids: { id: "grid_providers" }, handlers: { PATCH: admin({ name: "renamed" }), DELETE: admin() } },
  "grid/providers/usage": { handlers: { GET: ok() } },
  "grid/ai-status": { handlers: { GET: ok() } },
  "grid/providers/[id]/impact": { ids: { id: "grid_providers" }, handlers: { GET: ok() } },
  "grid/tables": { handlers: { GET: ok(), POST: ok() } },
  "grid/tables/[tableId]": { ids: { tableId: "grid_tables" }, handlers: { GET: ok(), PATCH: ok(), DELETE: ok() } },
  "grid/tables/[tableId]/ai/preview": { ids: { tableId: "grid_tables" }, handlers: { POST: ok({ prompt: "summarize", outputs: [{ key: "summary", type: "text" }] }) } },
  "grid/tables/[tableId]/ai": { ids: { tableId: "grid_tables" }, handlers: { POST: ok({ prompt: "summarize", outputs: [{ key: "summary", type: "text" }] }), PATCH: { valid: { columnId: "00000000-0000-4000-8000-000000000001" }, mayNotFindOwnRow: true } } },
  "grid/tables/[tableId]/campaigns": { ids: { tableId: "grid_tables" }, handlers: { POST: ok({ rowIds: [], newCampaignName: "From grid", fields: {} }) } },
  "grid/tables/[tableId]/cell-details": { ids: { tableId: "grid_tables" }, handlers: { GET: { mayNotFindOwnRow: true } } },
  "grid/tables/[tableId]/cell-runs": { ids: { tableId: "grid_tables" }, handlers: { GET: { query: { rowId: "00000000-0000-4000-8000-000000000001", columnKey: "x" }, mayNotFindOwnRow: true } } },
  "grid/tables/[tableId]/cells": { ids: { tableId: "grid_tables" }, handlers: { PATCH: ok({ rowId: "00000000-0000-4000-8000-000000000001", columnKey: "x", value: "y" }) } },
  "grid/tables/[tableId]/changes": { ids: { tableId: "grid_tables" }, handlers: { GET: ok() } },
  "grid/tables/[tableId]/columns": { ids: { tableId: "grid_tables" }, handlers: { GET: ok(), POST: ok() } },
  "grid/tables/[tableId]/columns/[columnId]": { ids: { columnId: { table: "grid_columns", links: { tableId: "table_id" } } }, handlers: { PATCH: ok(), DELETE: ok() } },
  "grid/tables/[tableId]/columns/[columnId]/dedupe": { ids: { columnId: { table: "grid_columns", links: { tableId: "table_id" } } }, handlers: { POST: ok() } },
  "grid/tables/[tableId]/columns/[columnId]/recalculate": { ids: { columnId: { table: "grid_columns", links: { tableId: "table_id" }, force: { type: "formula" } } }, handlers: { POST: ok() } },
  "grid/tables/[tableId]/columns/[columnId]/text-to-columns": { ids: { columnId: { table: "grid_columns", links: { tableId: "table_id" } } }, handlers: { POST: ok() } },
  "grid/tables/[tableId]/duplicate": { ids: { tableId: "grid_tables" }, handlers: { POST: ok() } },
  "grid/tables/[tableId]/enrichments": { ids: { tableId: "grid_tables" }, handlers: { POST: ok({ kind: "enrichment", providerKey: "fake", actionKey: "find-email", inputs: { fullName: "name", companyDomain: "domain" }, selectedOutputs: ["email"] }), PATCH: { valid: { columnId: "00000000-0000-4000-8000-000000000001" }, mayNotFindOwnRow: true } } },
  "grid/tables/[tableId]/enrichments/preview": { ids: { tableId: "grid_tables" }, handlers: { POST: ok({ steps: [{ providerKey: "fake", actionKey: "find-email" }], inputs: { fullName: "name", companyDomain: "domain" } }) } },
  "grid/tables/[tableId]/export": { ids: { tableId: "grid_tables" }, handlers: { POST: ok() } },
  "grid/tables/[tableId]/formula-generate": { ids: { tableId: "grid_tables" }, handlers: { POST: ok({ prompt: "add two columns" }) } },
  "grid/tables/[tableId]/formula-preview": { ids: { tableId: "grid_tables" }, handlers: { POST: ok() } },
  "grid/tables/[tableId]/import": { ids: { tableId: "grid_tables" }, handlers: { POST: { form: true } } },
  "grid/tables/[tableId]/paste": { ids: { tableId: "grid_tables" }, handlers: { POST: ok({ anchorRowId: "00000000-0000-4000-8000-000000000001", columnKeys: ["x"], values: [["y"]] }) } },
  "grid/tables/[tableId]/rows": { ids: { tableId: "grid_tables" }, handlers: { GET: ok(), POST: ok(), DELETE: ok({ rowIds: ["00000000-0000-4000-8000-000000000001"] }) } },
  "grid/tables/[tableId]/run": { ids: { tableId: "grid_tables" }, handlers: { GET: ok(), POST: ok(), DELETE: ok() } },
  "grid/tables/[tableId]/run/retry": { ids: { tableId: "grid_tables" }, handlers: { POST: ok() } },
  "grid/tables/[tableId]/selection": { ids: { tableId: "grid_tables" }, handlers: { GET: ok() } },
  "grid/tables/[tableId]/view": { ids: { tableId: "grid_tables" }, handlers: { PUT: ok(), DELETE: ok() } },
  "grid/workbooks": { handlers: { GET: ok(), POST: ok() } },
  "grid/workbooks/[workbookId]": { ids: { workbookId: "grid_workbooks" }, handlers: { GET: ok(), PATCH: ok(), DELETE: ok() } },
  "grid/workbooks/[workbookId]/tables/reorder": { ids: { workbookId: "grid_workbooks" }, handlers: { POST: ok({ tableIds: [] }) } },

  "inbound-events": { handlers: { GET: admin() } },
  "inbound-events/[id]/dismiss": { ids: { id: "inbound_events" }, handlers: { POST: admin() } },
  "inbound-events/[id]/retry": { ids: { id: "inbound_events" }, handlers: { POST: admin() } },
  "inbox/[id]/classification": { ids: { id: "conversations" }, handlers: { POST: ok({ subcategoryKey: null, expectedContextVersion: 0 }) } },
  "inbox/[id]/draft": { ids: { id: "conversations" }, handlers: { POST: ok({ subject: "Re: hello", bodyText: "Thanks for the note." }) } },
  "inbox/messages/[id]/important": { ids: { id: "messages" }, handlers: { POST: ok({ important: true }) } },
  "inbox/[id]/linkedin-reply": { ids: { id: "conversations" }, handlers: { POST: ok({ text: "Thanks", idempotencyKey: "key-12345678" }) } },
  "inbox/[id]/read": { ids: { id: "conversations" }, handlers: { POST: ok() } },
  "inbox/[id]/suppress": { ids: { id: "conversations" }, handlers: { POST: ok() } },
  "inbox/unread-count": { handlers: { GET: ok() } },
  "integrations": { handlers: { POST: admin({ providerKey: "anthropic", values: {} }) } },
  "integrations/ai-model": { handlers: { GET: admin(), PUT: admin({ model: null }) } },
  "integrations/[id]": { ids: { id: "integration_accounts" }, handlers: { DELETE: admin() } },
  "invitations/[id]": { ids: { id: "invitations" }, handlers: { GET: { idIsCapability: true }, DELETE: admin() } },
  "merge-fields": { handlers: { GET: ok() } },
  "knowledge": { handlers: { GET: ok(), POST: admin() } },
  "knowledge/[id]": { ids: { id: "knowledge_documents" }, handlers: { PATCH: admin() } },

  "leads/[id]": { ids: { id: "people" }, handlers: { GET: ok(), PATCH: ok(), DELETE: ok() } },
  "leads/[id]/convert": { ids: { id: "people" }, handlers: { POST: ok() } },
  "leads/[id]/make-contact": { ids: { id: "people" }, handlers: { POST: ok() } },
  "leads/convert": { handlers: { POST: ok({ ids: [SAMPLE_UUID] }) } },
  "leads/convert/preview": { handlers: { POST: ok({ ids: [SAMPLE_UUID] }) } },
  "leads/delete": { handlers: { POST: ok() } },
  "leads/columns": { handlers: { GET: ok(), POST: { admin: true, valid: { entity: "people", name: "Matrix column" } }, PUT: { admin: true, valid: { entity: "people", ids: [] } } } },
  "leads/columns/[id]": { ids: { id: "entity_columns" }, handlers: { PATCH: { admin: true, valid: { name: "Renamed by matrix" } }, DELETE: { admin: true } } },
  "leads/export": { handlers: { GET: ok() } },
  "leads/ids": { handlers: { GET: ok() } },
  "leads/import": { handlers: { POST: { form: true } } },
  "leads/import/preview": { handlers: { POST: { form: true } } },
  "leads/import/summary": { handlers: { POST: { form: true } } },
  "leads/import/sample": { handlers: { GET: ok() } },
  "leads/raw/map": { handlers: { POST: ok({ rawKey: "Region", name: "Region" }) } },

  "linkedin": { handlers: { GET: ok(), POST: admin({ dsn: "api1.unipile.com:13111", apiKey: "k" }), DELETE: admin() } },
  "linkedin/accounts/[id]": { ids: { id: "linkedin_accounts" }, handlers: { PATCH: admin({ dailyInviteLimit: 10 }) } },
  "linkedin/accounts/hosted-auth": { handlers: { POST: { admin: true, lenientBody: true } } },
  "linkedin/campaigns": { handlers: { GET: ok(), POST: ok() } },
  "linkedin/campaigns/[id]": { ids: { id: linkedinCampaign }, handlers: { GET: ok(), PATCH: ok(), DELETE: ok() } },
  "linkedin/campaigns/[id]/archive": { ids: { id: linkedinCampaign }, handlers: { POST: ok({ archived: true }) } },
  "linkedin/campaigns/[id]/enroll": { ids: { id: linkedinCampaign }, handlers: { POST: ok() } },
  "linkedin/campaigns/[id]/enrollments/[enrollmentId]": { ids: { enrollmentId: { table: "campaign_enrollments", force: { channel: "linkedin", parentForce: { campaigns: { channel: "linkedin", steps: LINKEDIN_STEPS } } }, links: { id: "campaign_id" } } }, handlers: { DELETE: ok() } },
  "linkedin/campaigns/[id]/enrollments/remove": { ids: { id: linkedinCampaign }, handlers: { POST: ok({ ids: [SAMPLE_UUID] }) } },
  "linkedin/campaigns/[id]/enrollments/restore": { ids: { id: linkedinCampaign }, handlers: { POST: ok({ ids: [SAMPLE_UUID] }) } },
  "linkedin/campaigns/[id]/preview": { ids: { id: linkedinCampaign }, handlers: { POST: ok({ step: 1 }) } },
  "linkedin/campaigns/[id]/status": { ids: { id: linkedinCampaign }, handlers: { POST: ok({ status: "active" }) } },
  "linkedin/search-batches": { handlers: { GET: ok(), POST: { form: true } } },
  "linkedin/search-batches/[id]": { ids: { id: batch }, handlers: { GET: ok(), DELETE: ok() } },
  "linkedin/search-batches/[id]/leads": { ids: { id: batch }, handlers: { DELETE: ok({ ids: [SAMPLE_UUID] }) } },
  "linkedin/search-batches/[id]/queries": {
    ids: { id: batch },
    handlers: { POST: ok({ urls: ["https://www.linkedin.com/search/results/people/?keywords=matrix"] }), DELETE: ok({ ids: [SAMPLE_UUID] }) },
  },
  "linkedin/search-batches/[id]/run": { ids: { id: batch }, handlers: { POST: { lenientBody: true } } },
  "linkedin/search-batches/[id]/rerun": { ids: { id: batch }, handlers: { POST: ok({ ids: [] }) } },
  "linkedin/search-batches/[id]/results": { ids: { id: batch }, handlers: { GET: ok() } },
  "linkedin/search-batches/template": { handlers: { GET: ok() } },
  "jobs/ai/requeue": { handlers: { POST: admin({ since: "2026-01-01T00:00:00Z" }) } },
  "jobs/ai/[id]/requeue": { ids: { id: { table: "ai_jobs", force: { status: "failed", failed_at: "2026-10-01T00:00:00Z", last_error: "provider outage" } } }, handlers: { POST: admin() } },
  "linkedin/jobs": { handlers: { GET: admin() } },
  "linkedin/jobs/replay-webhooks": { handlers: { POST: admin() } },
  "linkedin/jobs/reset-daily-limits": { handlers: { POST: admin() } },
  "linkedin/searches": { handlers: { GET: ok(), POST: ok() } },
  "linkedin/searches/[id]": { ids: { id: "linkedin_search_queries" }, handlers: { GET: ok() } },
  "linkedin/searches/[id]/action": { ids: { id: "linkedin_search_queries" }, handlers: { POST: ok({ action: "pause" }) } },
  "linkedin/sync": { handlers: { POST: admin() } },
  "linkedin/webhooks": { handlers: { POST: admin() } },
  "linkedin/webhooks/setup": { handlers: { POST: admin() } },

  "mailboxes": { handlers: { GET: ok(), POST: admin({ emailAddress: "new@matrix.test" }) } },
  "mailboxes/[id]": { ids: { id: "mailboxes" }, handlers: { PATCH: admin({ dailySendLimit: 10 }), DELETE: admin() } },
  "mailboxes/[id]/enabled": { ids: { id: "mailboxes" }, handlers: { POST: admin({ enabled: true }) } },
  "mailboxes/[id]/test": { ids: { id: "mailboxes" }, handlers: { POST: admin() } },
  "mailboxes/[id]/send-test": { ids: { id: "mailboxes" }, handlers: { POST: admin({ to: "tester@matrix.test" }) } },
  "members": { handlers: { POST: admin({ email: "invitee@matrix.test", role: "member" }) } },
  "members/[id]": { ids: { id: "members" }, handlers: { PATCH: admin({ role: "member" }), DELETE: admin() } },
  "organizations": { handlers: { GET: ok(), POST: ok({ name: "" }) } }, // an empty name never creates a row, whichever way the signup policy answers
  "organizations/active": { handlers: { POST: ok({ organizationId: "00000000-0000-4000-8000-000000000000" }) } },
  "people/search": { handlers: { GET: { query: { q: "matrix" } } } },
  "people/[personId]/notes": { ids: { personId: "people" }, handlers: { GET: ok(), POST: ok({ body: "note" }) } },
  "people/[personId]/notes/[noteId]": { ids: { noteId: { table: "notes", links: { personId: "person_id" } } }, handlers: { PATCH: ok({ body: "edited" }), DELETE: ok() } },
  "people/[personId]/tasks": { ids: { personId: "people" }, handlers: { GET: ok(), POST: ok({ name: "Call back" }) } },
  "onboarding/dismiss": { handlers: { POST: admin() } },
  "settings/organization": { handlers: { GET: ok(), PATCH: admin({ timeZone: "UTC" }) } },
  "settings/email-rules": { handlers: { GET: ok(), PATCH: admin({ minGapMinutes: 1, maxGapMinutes: 2, timeZone: "UTC" }) } },
};
