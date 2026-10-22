import { searchCompanies } from "@/contexts/leads/infrastructure/composition";
import { withActor } from "@/app/_lib/api";

/** Step 1 of the merge dialog: up to 20 companies by name or domain. `all=1` includes companies that Companies does not list. */
export function GET(request: Request) {
  return withActor(async (actor) => {
    const params = new URL(request.url).searchParams;
    const all = params.get("all") === "1" || params.get("all") === "true";
    return { companies: await searchCompanies(actor.organizationId, params.get("q") ?? "", { all }) };
  });
}
