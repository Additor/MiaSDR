import { sql } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { CONTACT_DELETE_STATEMENT_TIMEOUT, type ContactDeleteStore, type ContactForDelete } from "../application/contact-delete";
import { stampCompaniesLeftByContacts } from "./company-domain-store";

/*
 * The leads side of a contact delete ("Contacts and Companies CRUD" in docs/decisions.md):
 * the people row. Every statement filters by organization.
 */

const rowsOf = <T>(result: unknown) => result as unknown as T[];

interface PersonRow {
  id: string;
  full_name: string | null;
  email: string | null;
  linkedin_url: string | null;
  linkedin_slug: string | null;
  lifecycle: string;
  company_id: string | null;
  do_not_contact: boolean;
  suppressed: boolean;
}

const asPerson = (row: PersonRow | undefined): ContactForDelete | null =>
  row
    ? {
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        linkedinUrl: row.linkedin_url,
        linkedinSlug: row.linkedin_slug,
        lifecycle: row.lifecycle === "contact" ? "contact" : "lead",
        companyId: row.company_id,
        doNotContact: row.do_not_contact,
        suppressed: row.suppressed,
      }
    : null;

/** The person with the do not contact flag and the suppression state of the email. `FOR UPDATE OF p` locks the people row only. */
async function personOf(tx: DbHandle, organizationId: string, personId: string, lock: boolean): Promise<ContactForDelete | null> {
  const [row] = rowsOf<PersonRow>(
    await tx.execute(sql`
      select p.id, p.full_name, p.email, p.linkedin_url, p.linkedin_slug, p.lifecycle, p.company_id,
        coalesce((select cp.do_not_contact from contact_policies cp where cp.organization_id = p.organization_id and cp.person_id = p.id), false) as do_not_contact,
        exists (select 1 from suppression_list s where s.organization_id = p.organization_id and p.email is not null and s.email = lower(p.email)) as suppressed
      from people p
      where p.organization_id = ${organizationId} and p.id = ${personId}::uuid
      ${lock ? sql`for update of p` : sql``}`),
  );
  return asPerson(row);
}

export const drizzleContactDeleteStore: ContactDeleteStore = {
  read: (tx, organizationId, personId) => personOf(tx, organizationId, personId, false),
  lock: (tx, organizationId, personId) => personOf(tx, organizationId, personId, true),
  limitStatements: async (tx) => {
    await tx.execute(sql.raw(`set local statement_timeout = '${CONTACT_DELETE_STATEMENT_TIMEOUT}'`));
  },
  deletePerson: async (tx, organizationId, personId) => {
    await tx.execute(sql`delete from people where organization_id = ${organizationId} and id = ${personId}::uuid`);
  },
  stampCompaniesLeftByContacts,
};
