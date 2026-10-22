import { NotFoundError, ValidationError, type Actor } from "@/shared/errors";
import { planCompanyEdit, type CompanyEditInput, type CompanyEditPlan } from "../domain/company-edit";

/*
 * Leads owns the `companies` row: imports and the lead form create it by domain, and this use case edits its name,
 * LinkedIn page and company fields. The CRM Companies pages read it and send their edits here. Any member can edit,
 * the same as a lead.
 */

export interface CompanyStore {
  /**
   * Applies the plan to one company. Refuses a custom key that is not an active company field. False when the
   * company is not in the organization.
   */
  update(organizationId: string, companyId: string, plan: CompanyEditPlan): Promise<boolean>;
}

export interface CompanyDeps {
  companies: CompanyStore;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function updateCompany(deps: CompanyDeps, actor: Actor, companyId: string, input: CompanyEditInput): Promise<void> {
  if (!UUID.test(companyId)) throw new NotFoundError("Company not found");
  const plan = planCompanyEdit(input);
  if (plan.issues.length > 0) throw new ValidationError(plan.issues[0], plan.issues.map((message) => ({ message })));
  if (!(await deps.companies.update(actor.organizationId, companyId, plan))) throw new NotFoundError("Company not found");
}
