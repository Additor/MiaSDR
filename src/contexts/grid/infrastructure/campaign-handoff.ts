import { and, eq, inArray, sql } from "drizzle-orm";
import { importLeads } from "@/contexts/leads/application/import-leads";
import type { Mapping } from "@/contexts/leads/domain/import-plan";
import { defaultPhoneCountry } from "@/contexts/leads/infrastructure/default-phone-country";
import { drizzleLeadStore } from "@/contexts/leads/infrastructure/drizzle-lead-store";
import { normalizeEmail, normalizeLinkedinSlug } from "@/contexts/leads/domain/normalize";
import { DEFAULT_STEPS } from "@/contexts/outreach/application/campaign-management";
import { campaignDeps } from "@/contexts/outreach/infrastructure/composition";
import { enrollPeople } from "@/contexts/outreach/linkedin/infrastructure/drizzle-linkedin-campaign-store";
import { enrollEmailPeople } from "@/contexts/outreach/infrastructure/drizzle-management-stores";
import { db, type DbTx } from "@/platform/db/client";
import { campaignEnrollments, campaigns, contactPolicies, people, suppressionList } from "@/platform/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";
import type { CampaignHandoff, HandoffFailure } from "../application/ports";
import { buildLeadImport } from "../domain/campaign-rows";

const CHUNK = 1_000;

function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const textOf = (value: unknown): string | null => (typeof value === "string" ? value : typeof value === "number" ? String(value) : null);

/**
 * Leads come from the leads context (`importLeads`: the same validation, normalization and
 * de-duplication as a file import). Enrollment follows the outreach rules: a suppressed address,
 * a do-not-contact person and a person already in the campaign are skipped, and each skip is reported per row.
 * Nothing is sent here. A draft campaign stays a draft.
 *
 * The whole push runs in one transaction: the lead import, the new campaign and the enrollments commit together.
 * Any error, including one thrown after the campaign was created, leaves no campaign, no leads from this call and no enrollments.
 */
export const campaignHandoff: CampaignHandoff = {
  push(input) {
    return db.transaction((tx) => pushInTransaction(tx, input));
  },
};

async function pushInTransaction(tx: DbTx, input: Parameters<CampaignHandoff["push"]>[0]): ReturnType<CampaignHandoff["push"]> {
  const org = input.organizationId;

  let campaign: { id: string; channel: "email" | "linkedin"; status: string } | null = null;
  if (input.target.campaignId) {
    const [row] = await tx
      .select({ id: campaigns.id, channel: campaigns.channel, status: campaigns.status })
      .from(campaigns)
      .where(and(eq(campaigns.organizationId, org), eq(campaigns.id, input.target.campaignId)));
    if (!row) throw new NotFoundError("Campaign not found");
    if (row.status === "completed") throw new ConflictError("This campaign is completed.");
    campaign = { id: row.id, channel: row.channel as "email" | "linkedin", status: row.status };
  }
  const channel = campaign?.channel ?? "email";

  const failures: HandoffFailure[] = [];
  const identity = new Map<string, { email: string | null; slug: string | null }>();
  const usable: typeof input.rows = [];
  for (const row of input.rows) {
    const email = input.fields.email ? normalizeEmail(textOf(row.cells[input.fields.email])) : null;
    const slug = input.fields.linkedin ? normalizeLinkedinSlug(textOf(row.cells[input.fields.linkedin])) : null;
    if (channel === "email" && !email) failures.push({ rowId: row.id, reason: "Missing or invalid email" });
    else if (channel === "linkedin" && !slug) failures.push({ rowId: row.id, reason: "Missing or invalid LinkedIn URL" });
    else {
      identity.set(row.id, { email, slug });
      usable.push(row);
    }
  }

  // Suppressed addresses never become leads through this path.
  const emails = [...new Set([...identity.values()].flatMap((i) => (i.email ? [i.email] : [])))];
  const suppressed = await suppressedEmails(tx, org, emails);
  const importable = usable.filter((row) => {
    const email = identity.get(row.id)?.email;
    if (email && suppressed.has(email)) {
      failures.push({ rowId: row.id, reason: "Email is suppressed" });
      return false;
    }
    return true;
  });
  if (importable.length === 0) {
    throw new ValidationError("None of the selected rows can be added to this campaign.", failures.slice(0, 50).map((f) => ({ message: `${f.rowId}: ${f.reason}` })));
  }

  const lead = buildLeadImport(importable, input.columns, input.fields, input.customColumnKeys);
  const report = await importLeads(
    { store: drizzleLeadStore, defaultPhoneCountry },
    { tx, organizationId: org, userId: input.userId, filename: `grid:${input.tableName}`.slice(0, 200), headers: lead.headers, rows: lead.rows, mapping: lead.mapping as Mapping },
  );

  // Find each row's person by the identity the import used.
  const slugs = [...new Set(importable.flatMap((r) => (identity.get(r.id)?.slug ? [identity.get(r.id)!.slug as string] : [])))];
  const importEmails = [...new Set(importable.flatMap((r) => (identity.get(r.id)?.email ? [identity.get(r.id)!.email as string] : [])))];
  const byEmail = new Map<string, { id: string; email: string | null; slug: string | null }>();
  const bySlug = new Map<string, { id: string; email: string | null; slug: string | null }>();
  for (const part of chunked(importEmails)) {
    for (const p of await tx.select({ id: people.id, email: people.email, slug: people.linkedinSlug }).from(people).where(and(eq(people.organizationId, org), inArray(sql`lower(${people.email})`, part)))) byEmail.set((p.email as string).toLowerCase(), p);
  }
  for (const part of chunked(slugs)) {
    for (const p of await tx.select({ id: people.id, email: people.email, slug: people.linkedinSlug }).from(people).where(and(eq(people.organizationId, org), inArray(people.linkedinSlug, part)))) bySlug.set(p.slug as string, p);
  }

  const seenPerson = new Set<string>();
  const personRows: Array<{ rowId: string; person: { id: string; email: string | null; slug: string | null } }> = [];
  for (const row of importable) {
    const ident = identity.get(row.id)!;
    const byMail = ident.email ? byEmail.get(ident.email) : undefined;
    const byLink = ident.slug ? bySlug.get(ident.slug) : undefined;
    if (byMail && byLink && byMail.id !== byLink.id) {
      failures.push({ rowId: row.id, reason: "Email and LinkedIn profile belong to two different existing leads" });
      continue;
    }
    const person = byMail ?? byLink;
    if (!person) {
      failures.push({ rowId: row.id, reason: "The lead could not be created" });
      continue;
    }
    if (seenPerson.has(person.id)) {
      failures.push({ rowId: row.id, reason: "Same lead as an earlier selected row" });
      continue;
    }
    if (channel === "email" && !person.email) {
      failures.push({ rowId: row.id, reason: "The matching lead has no email" });
      continue;
    }
    if (channel === "linkedin" && !person.slug) {
      failures.push({ rowId: row.id, reason: "The matching lead has no LinkedIn profile" });
      continue;
    }
    seenPerson.add(person.id);
    personRows.push({ rowId: row.id, person });
  }

  // A matched lead can carry an address that is suppressed even though the row's own cell was another one.
  const lateSuppressed = channel === "email" ? await suppressedEmails(tx, org, personRows.flatMap((r) => (r.person.email ? [r.person.email.toLowerCase()] : []))) : new Set<string>();
  const personIds = personRows.map((r) => r.person.id);
  const doNotContact = new Set<string>();
  const contacts = new Set<string>();
  const already = new Set<string>();
  for (const part of chunked(personIds)) {
    const dnc = await tx
      .select({ id: contactPolicies.personId })
      .from(contactPolicies)
      .where(and(eq(contactPolicies.organizationId, org), inArray(contactPolicies.personId, part), eq(contactPolicies.doNotContact, true)));
    for (const row of dnc) doNotContact.add(row.id);
    // A lead who became a contact cannot be enrolled in a campaign. The row still counts as a lead import above.
    const converted = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.organizationId, org), inArray(people.id, part), eq(people.lifecycle, "contact")));
    for (const row of converted) contacts.add(row.id);
    if (campaign) {
      const enrolled = await tx
        .select({ id: campaignEnrollments.personId })
        .from(campaignEnrollments)
        .where(and(eq(campaignEnrollments.organizationId, org), eq(campaignEnrollments.campaignId, campaign.id), inArray(campaignEnrollments.personId, part)));
      for (const row of enrolled) already.add(row.id);
    }
  }

  const toEnroll: string[] = [];
  for (const { rowId, person } of personRows) {
    if (person.email && lateSuppressed.has(person.email.toLowerCase())) failures.push({ rowId, reason: "Email is suppressed" });
    else if (doNotContact.has(person.id)) failures.push({ rowId, reason: "Person is marked do not contact" });
    else if (already.has(person.id)) failures.push({ rowId, reason: "Person is already in this campaign" });
    else if (contacts.has(person.id)) failures.push({ rowId, reason: "Is a contact" });
    else toEnroll.push(person.id);
  }

  // Nothing is created for a new campaign until at least one lead is left to enroll.
  if (!campaign && toEnroll.length === 0) {
    throw new ValidationError("None of the selected rows can be added to this campaign.", failures.slice(0, 50).map((f) => ({ message: `${f.rowId}: ${f.reason}` })));
  }

  let created = false;
  let campaignId = campaign?.id;
  if (!campaignId) {
    campaignId = await campaignDeps().campaigns.create(org, { name: input.target.newCampaignName as string, createdBy: input.userId, steps: DEFAULT_STEPS }, tx);
    created = true;
  }

  const enrolled = toEnroll.length === 0 ? 0 : channel === "linkedin" ? await enrollPeople(org, campaignId, toEnroll, tx) : await enrollEmailPeople(org, campaignId, toEnroll, tx);

  return {
    campaignId,
    channel,
    created,
    enrolled,
    leadsCreated: report.stats.created,
    leadsUpdated: report.stats.updated,
    failures,
  };
}

async function suppressedEmails(tx: DbTx, organizationId: string, emails: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunked(emails)) {
    const rows = await tx
      .select({ email: suppressionList.email })
      .from(suppressionList)
      .where(and(eq(suppressionList.organizationId, organizationId), inArray(sql`lower(${suppressionList.email})`, part)));
    for (const row of rows) out.add(row.email.toLowerCase());
  }
  return out;
}
