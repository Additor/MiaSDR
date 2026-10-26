/** A person's own page: a contact's lives in the CRM, a lead's under Leads. `/leads/[id]` only redirects a contact there. */
export function personHref(id: string, lifecycle: string | null | undefined): string {
  return lifecycle === "contact" ? `/crm/contacts/${id}` : `/leads/${id}`;
}
