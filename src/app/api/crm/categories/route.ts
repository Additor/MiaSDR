import { CRM_CATEGORIES } from "@/contexts/conversations/domain/crm";
import { getCrmTaxonomy } from "@/contexts/conversations/application/crm";
import { crmDeps } from "@/contexts/conversations/infrastructure/crm-composition";
import { withActor } from "@/shared/api";

/** The four fixed categories, the pipeline's subcategories with usage counts, and its AI settings. */
export const GET = () => withActor(async (actor) => ({ categories: CRM_CATEGORIES, ...(await getCrmTaxonomy(crmDeps(), actor)) }));
