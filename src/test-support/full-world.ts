import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { dropOrgs } from "./db";

/**
 * Test fixture for the schema integration tests: one organization with a row in every table the foreign keys, checks
 * and append-only triggers cover. Not used by production code.
 */
export interface World {
  tag: string;
  org: string;
  user: string;
  person: string;
  pipeline: string;
  subA: string;
  subB: string;
  record: string;
  conversation: string;
  message: string;
  classification: string;
  draft: string;
  sendAttempt: string;
  mailbox: string;
  mailbox2: string;
  linkedinAccount: string;
  campaign: string;
  enrollment: string;
  sendEmail: string;
  sendLinkedin: string;
  connection: string;
  searchBatch: string;
  searchQuery: string;
  note: string;
  task: string;
  importRun: string;
  /** A person with lifecycle 'contact', and the one deal of that contact. The deal's source enrollment is `enrollment`. */
  contact: string;
  dealStage: string;
  deal: string;
  /** A company and one of its other domains (company_domain_aliases). */
  company: string;
  companyAlias: string;
  knowledgeDoc: string;
  event: string;
  audit: string;
}

type Sql = postgres.Sql;

export function uid(): string {
  return randomUUID();
}

export async function seedWorld(sql: Sql): Promise<World> {
  const tag = Math.random().toString(36).slice(2, 10);
  const one = async (rows: PromiseLike<Array<{ id: string }>>) => (await rows)[0].id;
  const org = await one(sql`insert into organizations (name, slug) values ('T8', ${"t8-" + tag}) returning id`);
  const user = await one(sql`insert into users (name, email) values ('U', ${tag + "@t8.test"}) returning id`);
  const person = await one(sql`insert into people (organization_id, email, full_name) values (${org}, ${tag + "@lead.test"}, 'Lead') returning id`);
  const pipeline = await one(sql`insert into reply_type_sets (organization_id, name, is_default) values (${org}, 'p', true) returning id`);
  const subA = await one(sql`insert into reply_types (organization_id, reply_type_set_id, group_key, key, name) values (${org}, ${pipeline}, 'interested', 'a', 'A') returning id`);
  const subB = await one(sql`insert into reply_types (organization_id, reply_type_set_id, group_key, key, name) values (${org}, ${pipeline}, 'interested', 'b', 'B') returning id`);
  const record = await one(sql`insert into records (organization_id, person_id, reply_type_set_id) values (${org}, ${person}, ${pipeline}) returning id`);
  const conversation = await one(sql`insert into conversations (organization_id, record_id, channel, account_ref) values (${org}, ${record}, 'email', ${"me@" + tag + ".test"}) returning id`);
  const message = await one(sql`
    insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
    values (${org}, ${conversation}, 'email', ${"me@" + tag + ".test"}, 'inbound', ${"m-" + tag}, 'hello', now()) returning id`);
  await sql`update records set latest_inbound_message_id = ${message} where id = ${record}`;
  const classification = await one(sql`
    insert into reply_type_picks (organization_id, record_id, message_id, expected_context_version, previous_reply_type_id, proposed_reply_type_id, applied_reply_type_id, confidence)
    values (${org}, ${record}, ${message}, 0, ${subA}, ${subA}, ${subA}, 0.9) returning id`);
  const draft = await one(sql`
    insert into drafts (organization_id, record_id, conversation_id, reply_for_message_id, expected_context_version, channel)
    values (${org}, ${record}, ${conversation}, ${message}, 0, 'email') returning id`);
  const sendAttempt = await one(sql`insert into send_attempts (organization_id, draft_id, idempotency_key, actor_user_id) values (${org}, ${draft}, ${"sa-" + tag}, ${user}) returning id`);
  const mailbox = await one(sql`insert into mailboxes (organization_id, email_address) values (${org}, ${"mb-" + tag + "@t8.test"}) returning id`);
  const mailbox2 = await one(sql`insert into mailboxes (organization_id, email_address) values (${org}, ${"mb2-" + tag + "@t8.test"}) returning id`);
  const linkedinAccount = await one(sql`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id) values (${org}, ${"pa-" + tag}, ${"li-" + tag}) returning id`);
  const campaign = await one(sql`insert into campaigns (organization_id, channel, name) values (${org}, 'email', 'c') returning id`);
  const enrollment = await one(sql`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel) values (${org}, ${campaign}, ${person}, 'email') returning id`);
  const sendEmail = await one(sql`
    insert into sends (organization_id, enrollment_id, step_number, channel, mailbox_id, taken_over_from_mailbox_id)
    values (${org}, ${enrollment}, 1, 'email', ${mailbox}, ${mailbox2}) returning id`);
  const sendLinkedin = await one(sql`
    insert into sends (organization_id, enrollment_id, step_number, channel, linkedin_account_id)
    values (${org}, ${enrollment}, 2, 'linkedin', ${linkedinAccount}) returning id`);
  const connection = await one(sql`
    insert into linkedin_connections (organization_id, linkedin_account_id, provider_id, enrollment_id)
    values (${org}, ${linkedinAccount}, ${"pid-" + tag}, ${enrollment}) returning id`);
  const searchBatch = await one(sql`insert into linkedin_search_batches (organization_id, name) values (${org}, 'b') returning id`);
  const searchQuery = await one(sql`
    insert into linkedin_search_queries (organization_id, batch_id, url, current_account_id)
    values (${org}, ${searchBatch}, 'https://example.test/search', ${linkedinAccount}) returning id`);
  const note = await one(sql`insert into notes (organization_id, person_id, record_id, body) values (${org}, ${person}, ${record}, 'n') returning id`);
  const task = await one(sql`insert into tasks (organization_id, person_id, record_id, name) values (${org}, ${person}, ${record}, 't') returning id`);
  const importRun = await one(sql`insert into import_runs (organization_id, destination, destination_campaign_id) values (${org}, 'campaign', ${campaign}) returning id`);
  const contact = await one(sql`
    insert into people (organization_id, email, full_name, lifecycle, converted_at) values (${org}, ${"c-" + tag + "@lead.test"}, 'Contact', 'contact', now()) returning id`);
  const dealStage = await one(sql`insert into deal_stages (organization_id, name, kind, position) values (${org}, 'New', 'open', 1) returning id`);
  const deal = await one(sql`
    insert into deals (organization_id, person_id, stage_id, stage_kind, title, source_enrollment_id)
    values (${org}, ${contact}, ${dealStage}, 'open', 'Deal', ${enrollment}) returning id`);
  const company = await one(sql`insert into companies (organization_id, domain, name) values (${org}, ${tag + ".t8.test"}, 'T8 Co') returning id`);
  const companyAlias = await one(sql`
    insert into company_domain_aliases (organization_id, company_id, domain, merged_name) values (${org}, ${company}, ${"was-" + tag + ".t8.test"}, 'Was') returning id`);
  // latest_version is a deferred foreign key: the document and its first version go in one transaction.
  const knowledgeDoc = await sql.begin(async (tx) => {
    const id = await one(tx`insert into knowledge_documents (organization_id, title, kind) values (${org}, 'k', 'faq') returning id`);
    await tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${org}, ${id}, 1, 'c')`;
    return id;
  });
  const event = await one(sql`
    insert into events (organization_id, person_id, record_id, event_type, actor_type, actor_user_id)
    values (${org}, ${person}, ${record}, 'note', 'human', ${user}) returning id`);
  const audit = await one(sql`insert into audit_log (organization_id, actor_user_id, action) values (${org}, ${user}, 'test.action') returning id`);
  return {
    tag, org, user, person, pipeline, subA, subB, record, conversation, message, classification, draft, sendAttempt, mailbox, mailbox2,
    linkedinAccount, campaign, enrollment, sendEmail, sendLinkedin, connection, searchBatch, searchQuery, note, task, importRun, contact, dealStage, deal, company, companyAlias, knowledgeDoc, event, audit,
  };
}

/**
 * Deletes the organization (cascades) and the user. Swallows errors: a failed test must not hide behind its own cleanup.
 * Deals go first: deals_stage_fk and deals_person_fk are RESTRICT, which a cascade from the organization does not wait out.
 */
export async function dropWorld(sql: Sql, w: Pick<World, "org" | "user">): Promise<void> {
  await dropOrgs(sql, [{ organizationId: w.org, userId: w.user }]);
}
