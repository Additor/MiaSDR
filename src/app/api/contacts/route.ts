import { NextResponse } from "next/server";
import { z } from "zod";
import { addContactWithDealDeps, createContact } from "@/composition/person-lifecycle";
import { addContactWithDeal, listContacts } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { withActor } from "@/app/_lib/api";
import { dealFieldsSchema } from "@/app/api/deals/validation";

/**
 * The Contacts list: `q`, `page`, `sort` (`converted`, the default, newest conversion first; `name`; `activity`), `owner` (a
 * user id, `me` or `none`) and `stage` (a deal stage id). Both filters read each contact's latest deal. 25 per page.
 */
export function GET(request: Request) {
  return withActor(async (actor) => {
    const { q, page, sort, owner, stage } = Object.fromEntries(new URL(request.url).searchParams);
    return listContacts(dealsDeps(), actor, { q, page: page === undefined ? null : Number(page), sort, owner, stage });
  });
}

const field = (max: number) => z.string().max(max).nullable().optional();

const addContactSchema = z.object({
  firstName: field(200),
  lastName: field(200),
  email: field(320),
  linkedinUrl: field(2000),
  title: field(500),
  companyDomain: field(2000),
  companyName: field(500),
  deal: dealFieldsSchema.omit({ idempotencyKey: true }).nullable().optional(),
  /** One per dialog open, 8 to 200 characters; the use cases answer 422 outside that range. */
  idempotencyKey: z.string().max(400),
});

/**
 * Add contact: a person who starts as a contact, with a deal when `deal` is sent. 201 with `{ personId }` or
 * `{ personId, dealId }`; a repeat with the same `idempotencyKey` answers 200 with the first result. 409 `lead_exists` or
 * `contact_exists` when someone holds the email or LinkedIn profile.
 */
export async function POST(request: Request) {
  let replayed = false;
  const response = await withActor(async (actor) => {
    const { deal, idempotencyKey, ...contact } = addContactSchema.parse(await request.json());
    if (deal) {
      const result = await addContactWithDeal(addContactWithDealDeps(), actor, { ...contact, deal, idempotencyKey });
      replayed = result.replayed;
      return { personId: result.personId, dealId: result.dealId };
    }
    const result = await createContact(actor, { ...contact, creationKey: idempotencyKey });
    replayed = result.replayed;
    return { personId: result.personId };
  }, 201);
  return replayed ? NextResponse.json(await response.json(), { status: 200 }) : response;
}
