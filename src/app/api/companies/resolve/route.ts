import { findCompanyByDomain } from "@/contexts/leads/infrastructure/composition";
import { withActor } from "@/shared/api";

/** The live lookup of the domain field: the company that holds `?domain=` as its domain or another domain, or null. 422 for a domain that names no company. */
export function GET(request: Request) {
  return withActor(async (actor) => ({ company: await findCompanyByDomain(actor.organizationId, new URL(request.url).searchParams.get("domain") ?? "") }));
}
