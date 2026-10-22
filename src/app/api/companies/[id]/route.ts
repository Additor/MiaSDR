import { z } from "zod";
import { companyLifecycleDeps } from "@/composition/person-lifecycle";
import { getCompany } from "@/contexts/deals/application/deals";
import { dealsDeps } from "@/contexts/deals/infrastructure/deals-composition";
import { deleteCompany } from "@/contexts/leads/application/company-lifecycle";
import { updateCompany } from "@/contexts/leads/application/company-management";
import { companyDeps } from "@/contexts/leads/infrastructure/composition";
import { withActor } from "@/app/_lib/api";
import { ValidationError } from "@/shared/errors";

/** One company with its contacts and their deals, its `version`, `crmListedAt`, other domains and people counts. */
export async function GET(_request: Request, ctx: RouteContext<"/api/companies/[id]">) {
  const { id } = await ctx.params;
  return withActor((actor) => getCompany(dealsDeps(), actor, id));
}

const text = z.string().max(2000).nullable().optional();
const editSchema = z.strictObject({
  name: text,
  linkedin: text,
  custom: z.record(z.string().max(100), z.string().max(5000)).optional(),
});

/** Name, LinkedIn page and company fields. Leads owns the company row, so the edit goes through its use case. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/companies/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const input = editSchema.parse(await request.json());
    await updateCompany(companyDeps(), actor, id, input);
    return { ok: true };
  });
}

/**
 * Deletes a company that no person points at, with its other domains. `?expectedVersion=` makes the delete
 * refuse a company that changed since the page read it. 404; 409 `company_in_use { contacts, leads }`, `company_changed`.
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/companies/[id]">) {
  const { id } = await ctx.params;
  return withActor(async (actor) => {
    const raw = new URL(request.url).searchParams.get("expectedVersion");
    const expectedVersion = raw === null ? undefined : Number(raw);
    if (expectedVersion !== undefined && (raw === "" || !Number.isInteger(expectedVersion))) throw new ValidationError("Send the company's current version.");
    await deleteCompany(companyLifecycleDeps, actor, id, { expectedVersion });
    return { ok: true };
  });
}
