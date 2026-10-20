import { NextResponse } from "next/server";
import { z } from "zod";
import { companyLifecycleDeps } from "@/composition/person-lifecycle";
import { listCompanies } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { addCompany } from "@/contexts/leads/application/company-lifecycle";
import { withActor } from "@/shared/api";

/**
 * The Companies list (M3): companies listed in Companies or with a contact. `q`, `page`, `sort` (`name`, the default;
 * `contacts`; `open_deals`). 25 per page.
 */
export function GET(request: Request) {
  return withActor(async (actor) => {
    const params = new URL(request.url).searchParams;
    const page = params.get("page");
    return listCompanies(dealsDeps(), actor, { q: params.get("q"), page: page === null ? null : Number(page), sort: params.get("sort") });
  });
}

const addSchema = z.object({
  domain: z.string().max(2000),
  name: z.string().max(2000).nullable().optional(),
  linkedinUrl: z.string().max(2000).nullable().optional(),
});

/**
 * Add company. 201 `{ companyId, listed: true }` for a new company; 200 for a company with leads only, which
 * joins Companies. 409 `company_exists` for a listed company or another domain of one; 422 for a domain that names no company.
 */
export async function POST(request: Request) {
  let created = true;
  const response = await withActor(async (actor) => {
    const result = await addCompany(companyLifecycleDeps, actor, addSchema.parse(await request.json()));
    created = result.created;
    return { companyId: result.companyId, listed: result.listed };
  }, 201);
  return created ? response : NextResponse.json(await response.json(), { status: 200 });
}
